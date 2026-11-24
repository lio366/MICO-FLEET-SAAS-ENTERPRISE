/**
 * MIDDLEWARE MULTI-TENANT — El "portero" del edificio SaaS
 * Versión 7.2 (E-028)
 *
 * Cada broker entra por su propia puerta (subdominio o dominio propio).
 * Este portero:
 *   1. Identifica qué broker está llamando (Host → tenants, con caché en memoria)
 *   2. Verifica que esté al día de pago (si no: 402)
 *   3. Verifica que no haya excedido los límites de su plan
 *   4. Da a la petición req.enTenant(fn): cada acceso a datos corre en una transacción con
 *      app.current_tenant LOCAL a esa transacción, y las reglas RLS hacen el resto.
 *
 * Cambios respecto a v5.x (todos eran defectos que impedían arrancar o aislar):
 *   - Los métodos se pasaban al gateway sin enlazar (this === undefined) y desde la clase,
 *     no desde una instancia: app.use(undefined) impedía arrancar el servidor.
 *   - Exigía Redis, que el proyecto descartó; ahora caché en memoria con TTL (Redis opcional no aplica).
 *   - setTenantContext usaba set_config(..., false) sobre el pool: el contexto quedaba pegado a una
 *     conexión cualquiera y podía heredarlo otra petición de otra empresa.
 *   - login() usaba tenant_users y bcrypt sin importarlo; el login real es 41_auth_rbac (tabla users).
 * La lógica vive en server/http/contexto_tenant.js (sin Express) para poder probarla con PostgreSQL real.
 */
const ctx = require('./server/http/contexto_tenant');

// DDL del núcleo multi-tenant (aplicado por db/esquema.js)
const SQL = require('./db/sql').leerSql('02_tenant_middleware'); // DDL versionado en sql/02_tenant_middleware.sql (E-017)

// Recursos con límite de plan: tabla y columna del límite. Lista cerrada (nada viene de la petición).
const LIMITES = {
    drivers: { tabla: 'drivers', filtro: 'is_active IS TRUE', limite: 'max_trucks', nombre: 'camiones' },
    users: { tabla: 'users', filtro: 'is_active IS TRUE', limite: 'max_users', nombre: 'usuarios' },
};

class TenantMiddleware {
    /**
     * @param {Pool} db  Pool del rol runtime (mf_app).
     * @param {{dominioBase?:string, ttlMs?:number}} opciones
     */
    constructor(db, { dominioBase, ttlMs } = {}) {
        if (!db || typeof db.connect !== 'function') throw new Error('TenantMiddleware requiere un Pool de pg');
        this.db = db;
        this.resolver = ctx.crearResolverTenant({ db, dominioBase, ttlMs });
        // Métodos enlazados: se pueden pasar directamente a app.use().
        this.identifyTenant = ctx.identificarTenant(this.resolver);
        this.verifySubscription = ctx.verificarSuscripcion();
        this.setTenantContext = ctx.adjuntarContexto(db);
        this.checkPlanLimit = this.checkPlanLimit.bind(this);
    }

    /**
     * Límites del plan (cuántos camiones y usuarios puede tener). Cuenta dentro del contexto del
     * tenant: con RLS, contar fuera del contexto devolvía 0 y el límite nunca se aplicaba.
     */
    checkPlanLimit(recurso) {
        const def = LIMITES[recurso];
        if (!def) throw new Error(`Recurso sin límite de plan definido: ${recurso}`);
        return async (req, res, next) => {
            try {
                const tenant = req.tenant;
                const { rows } = await ctx.enTenant(this.db, tenant.id,
                    c => c.query(`SELECT count(*)::int AS n FROM ${def.tabla} WHERE ${def.filtro}`), { soloLectura: true });
                const limite = tenant[def.limite];
                if (rows[0].n >= limite) {
                    return res.status(403).json({
                        error: 'Límite del plan alcanzado',
                        message: `Tu plan permite máximo ${limite} ${def.nombre}. Mejora tu plan en /billing/upgrade`,
                        current: rows[0].n,
                        limit: limite
                    });
                }
                return next();
            } catch (e) { return next(e); }
        };
    }
}

TenantMiddleware.SQL = SQL;
TenantMiddleware.LIMITES = LIMITES;
module.exports = TenantMiddleware;
