/**
 * backend/shared/rls-context.js
 *
 * AsyncLocalStorage singleton para el contexto de Row Level Security (L1.1).
 * Vive aquí (no en server.js) para evitar import circular: shared/middlewares.js
 * lo importa para envolver `verificarJWT` con `rlsContext.run({ userId })`, y
 * server.js lo importa para el extension Prisma `withCurrentUserRls`.
 *
 * Store schema: `{ userId: number }`.
 *
 * Quién lo monta:
 *   - shared/middlewares.js `verificarJWT` post-decodificación del JWT.
 * Quién lo lee:
 *   - server.js extension Prisma `withCurrentUserRls` para tomar el id sin pasarlo.
 *
 * Si se necesita exponer más adelante (p.ej. roleId, tenantId), agregar al
 * store sin romper signatura: `{ userId, ...meta }`.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const rlsContext = new AsyncLocalStorage();

module.exports = { rlsContext };
