/**
 * backend/modules/admin/ops/schema.js
 *
 * Zod DTOs del módulo admin/ops (Mapa NOC, Incidencias, Track público,
 * UsuarioPortal mgmt, Verify público, AuditCaja, _meta endpoints).
 *
 * Cyber Neo:
 *   - PIN tracking: `/^[A-Z2-9]{6}$/` evita confusión I/O/1/0 + uppercase
 *     (input case-insensitive normalizado).
 *   - Verify hash: `/^[a-f0-9]{24}$/` — HMAC truncado a 24 hex.
 *   - Resolución incidencia: 3-500 chars (anti spam + anti truncado).
 */

const { z } = require('zod');

const incidenciaQuerySchema = z.object({
  tipo:       z.string().optional(),
  severidad:  z.string().optional(),
  resueltas:  z.enum(['true', 'false']).optional(),
});

const resolverIncidenciaSchema = z.object({
  resolucion: z.string().min(3).max(500),
});

const trackPinSchema = z.object({
  pin: z.string().regex(/^[A-Z2-9]{6}$/, 'PIN inválido.'),
});

const verifyHashSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{24}$/, 'Hash inválido.'),
});

const auditCajaQuerySchema = z.object({
  tipo:  z.string().optional(),
  limit: z.string().optional().default('100'),
});

const auditVerifyQuerySchema = z.object({
  limit: z.string().optional().default('500'),
});

const metaEndpointsQuerySchema = z.object({
  refresh: z.enum(['0', '1']).optional(),
});

module.exports = {
  incidenciaQuerySchema,
  resolverIncidenciaSchema,
  trackPinSchema,
  verifyHashSchema,
  auditCajaQuerySchema,
  auditVerifyQuerySchema,
  metaEndpointsQuerySchema,
};
