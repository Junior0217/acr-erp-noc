/**
 * backend/modules/admin/pos-autorizacion/schema.js
 *
 * Zod DTOs para los nuevos canales de bypass del POS:
 *   1) TOTP — token de 6 dígitos del Authenticator del usuario autenticado.
 *   2) Webhook remoto — challenge async firmado con AUDIT_SECRET.
 *
 * NO sustituyen al PIN (EmpresaPerfil.pinSupervisor) — son alternativas
 * adicionales que el operador puede elegir según contexto y disponibilidad.
 */

const { z } = require('zod');

const totpSchema = z.object({
  token: z.string().regex(/^\d{6}$/, 'TOTP debe ser exactamente 6 dígitos numéricos'),
});

const webhookRequestSchema = z.object({
  motivo: z.string().trim().max(200).optional(),
});

const webhookApproveSchema = z.object({
  challengeId: z.string().uuid(),
  signature:   z.string().min(32).max(128),
  decision:    z.enum(['approved', 'rejected']),
});

const webhookStatusParamsSchema = z.object({
  id: z.string().uuid(),
});

module.exports = {
  totpSchema,
  webhookRequestSchema,
  webhookApproveSchema,
  webhookStatusParamsSchema,
};
