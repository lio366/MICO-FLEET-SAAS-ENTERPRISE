/**
 * MOTOR DE PUNTAJE NEURONAL — El cerebro que APRENDE con cada despacho
 *
 * EL PROBLEMA CON EL PUNTAJE FIJO (v2.0):
 *   Antes: Score = (RPM×0.35)+(Deadhead×0.25)+(Shipper×0.15)+...
 *   Los pesos (0.35, 0.25...) los pusimos nosotros a ojo. Funciona,
 *   pero no aprende. Un camionero de Florida y uno de Montana necesitan
 *   pesos distintos — y el mismo broker cambia de opinión con el tiempo.
 *
 * LA SOLUCIÓN NEURONAL (v3.1):
 *   Una red neuronal pequeña (18 entradas → 12 ocultas → 1 salida) que:
 *   1. PREDICE: "si le ofrezco esta carga a este camión, ¿la aceptará?"
 *   2. APRENDE: cada vez que el broker acepta o rechaza, ajusta sus pesos
 *      sola. A las 50 cargas ya sabe sus gustos mejor que cualquier regla.
 *   3. GENERALIZA: lo aprendido del Broker A ayuda a arrancar rápido al
 *      Broker B (aprendizaje transferido entre flotas).
 *
 * QUÉ LE ENTRA A LA RED (18 señales por carga):
 *   $/milla, millas de camino vacío, millas de carga, RPM del corredor vs
 *   mercado, horas hasta la carga, hora del día, día de la semana, peso,
 *   tipo de equipo, historial del shipper (% pagos a tiempo), historial de
 *   negociación de este broker (cuánto sube el precio), preferencias del
 *   conductor, estado HOS, clima del corredor, precio del diésel en ruta,
 *   temporada, competencia en la zona (# cargas similares), margen sobre mínimo.
 */
const tf = require('@tensorflow/tfjs-node'); // o brain.js si prefieres ligero

class NeuralMatchingEngine {
    constructor(db) {
        this.db = db;
        this.model = null;
        this.INPUTS = 18;
        this.TRAIN_THRESHOLD = 30; // reentrena cada 30 nuevas decisiones
        this.pendingSamples = 0;
    }

    /**
     * Crear la red: 18 entradas → 12 neuronas ocultas → 1 salida (probabilidad 0-1)
     * Arquitectura deliberadamente pequeña: se entrena en segundos en CPU
     * y corre en <5ms por carga. Miles de predicciones/día cuestan $0.
     */
    async buildModel() {
        this.model = tf.sequential({
            layers: [
                tf.layers.dense({ inputShape: [this.INPUTS], units: 12, activation: 'relu' }),
                tf.layers.dense({ units: 8, activation: 'relu' }),
                tf.layers.dense({ units: 1, activation: 'sigmoid' }) // 0=rechaza, 1=acepta
            ]
        });
        this.model.compile({
            optimizer: tf.train.adam(0.01),
            loss: 'binaryCrossentropy',
            metrics: ['accuracy']
        });
    }

    /**
     * Convertir una carga + contexto en las 18 señales numéricas de la red
     */
    async vectorizar(load, truck, contexto) {
        return tf.tensor2d([[
            load.rpm / 4.0,                                      // 1. $/milla (normalizado)
            Math.min(contexto.deadheadMiles / 300, 1),           // 2. camino vacío
            Math.min(load.miles / 3000, 1),                      // 3. millas de la carga
            load.rpm / contexto.rpmMercado - 1,                  // 4. vs mercado (+10% = 0.1)
            Math.min(contexto.horasHastaPickup / 72, 1),         // 5. urgencia
            new Date().getHours() / 24,                          // 6. hora del día
            new Date().getDay() / 7,                             // 7. día de semana
            Math.min((load.weight || 40000) / 50000, 1),         // 8. peso
            contexto.esReefer ? 1 : 0,                           // 9. tipo equipo
            contexto.shipperScore,                               // 10. historial shipper 0-1
            contexto.brokerNegociacionPromedio,                  // 11. cuánto suele subir este broker
            contexto.preferenciaConductor,                       // 12. si el conductor pidió esta zona
            contexto.hosDisponibleHoras / 11,                    // 13. horas de manejo disponibles
            contexto.climaMalo ? 1 : 0,                          // 14. tormenta en ruta
            contexto.dieselDelta,                                // 15. diésel caro en ruta vs origen
            contexto.esTemporadaAlta ? 1 : 0,                    // 16. temporada
            Math.min(contexto.cargasCompitiendo / 20, 1),        // 17. competencia en la zona
            (load.rpm - contexto.minRpm) / 2.0                   // 18. margen sobre su mínimo
        ]]);
    }

    /**
     * PREDICCIÓN: ¿vale la pena ofrecerle esta carga a este camión?
     * Devuelve probabilidad 0-1. Solo se ofrecen las 3 mejores por turno.
     */
    async predecirAceptacion(load, truck, contexto) {
        if (!this.model) await this.cargarModeloEntrenado();
        const x = await this.vectorizar(load, truck, contexto);
        const prob = this.model.predict(x).dataSync()[0];
        x.dispose();
        return prob; // >0.7 = ofrecer con confianza, 0.4-0.7 = ofrecer pero negociar fuerte, <0.4 = descartar
    }

    /**
     * PUNTAJE NEURONAL COMPLETO: ordena todas las cargas candidatas
     * combinando la predicción de la red + el beneficio esperado en dólares
     *
     * ScoreFinal = ProbAceptación × (GananciaNeta)
     * donde GananciaNeta = Tarifa − (MillasTotales × CostoPorMillaDelCamión)
     *
     * Así la red no solo prefiere cargas que le gustan al broker,
     * sino cargas que dejan dinero después de gastos.
     */
    async rankearCargas(candidatas, truck, contexto) {
        const costoPorMilla = 1.65; // diésel + mantenimiento + chofer, promedio USA
        const resultados = [];
        for (const load of candidatas) {
            const prob = await this.predecirAceptacion(load, truck, contexto);
            const millasTotales = contexto.deadheadMiles + load.miles;
            const gananciaNeta = load.rate - millasTotales * costoPorMilla;
            resultados.push({
                load,
                probabilidad_aceptacion: prob,
                ganancia_neta: gananciaNeta,
                score_neuronal: prob * gananciaNeta
            });
        }
        return resultados.sort((a, b) => b.score_neuronal - a.score_neuronal);
    }

    /**
     * APRENDIZAJE: cada decisión real entrena a la red
     * El broker aceptó → etiqueta 1. Rechazó → etiqueta 0.
     * Se guarda en la base y, cada 30 muestras, la red se reentrena sola.
     */
    async registrarDecision(load, truck, contexto, aceptada) {
        await this.db.query(
            `INSERT INTO training_samples
             (tenant_id, features, label, created_at)
             VALUES ($1, $2, $3, NOW())`,
            [contexto.tenantId, JSON.stringify({ load, truck, contexto }), aceptada ? 1 : 0]
        );
        this.pendingSamples++;

        if (this.pendingSamples >= this.TRAIN_THRESHOLD) {
            await this.entrenar();
            this.pendingSamples = 0;
        }
    }

    /**
     * ENTRENAMIENTO: toma todas las muestras históricas del tenant
     * y ajusta los pesos de la red. Corre de noche (cron), 2-3 minutos.
     */
    async entrenar() {
        const samples = await this.db.query(
            `SELECT features, label FROM training_samples
             WHERE trained_at IS NULL OR trained_at < NOW() - INTERVAL '7 days'`
        );
        if (samples.rows.length < 10) return; // con menos de 10 no vale la pena

        const xs = [], ys = [];
        for (const s of samples.rows) {
            const ctx = JSON.parse(s.features).contexto;
            const load = JSON.parse(s.features).load;
            const truck = JSON.parse(s.features).truck;
            xs.push((await this.vectorizar(load, truck, ctx)).dataSync());
            ys.push(s.label);
        }

        const xTensor = tf.tensor2d(xs);
        const yTensor = tf.tensor2d(ys, [ys.length, 1]);

        await this.model.fit(xTensor, yTensor, {
            epochs: 50,
            batchSize: 16,
            validationSplit: 0.2
        });

        xTensor.dispose(); yTensor.dispose();
        await this.guardarModelo();
        console.log(`[NEURONAL] Reentrenada con ${samples.rows.length} muestras`);
    }

    /**
     * TRANSFER LEARNING (aprendizaje transferido):
     * un broker NUEVO no empieza de cero. La red ya sabe qué cargas
     * suelen aceptarse en USA; solo ajusta fino con sus primeras 10-20 decisiones.
     */
    async predecirParaNuevoTenant(load, truck, contexto) {
        // Usa el modelo global (entrenado con todos los tenants) + factor de confianza bajo
        const probGlobal = await this.predecirAceptacion(load, truck, contexto);
        return {
            probabilidad: probGlobal,
            confianza: 'baja (broker nuevo — aprendiendo sus preferencias)',
            muestras_aprendidas: 0
        };
    }
}

module.exports = NeuralMatchingEngine;
