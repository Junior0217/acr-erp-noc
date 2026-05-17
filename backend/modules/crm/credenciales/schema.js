/**
 * backend/modules/crm/credenciales/schema.js
 *
 * Zod DTOs del Vault PAM. Cyber Neo:
 *   - password: 1-500 chars (UI permite long passwords con símbolos).
 *   - notas: max 500 (anti DoS).
 *   - tipo: enum cerrado (sin "Otros" libre de input).
 *   - clienteId: UUID estricto (anti SQLi via prisma).
 */

const { z } = require('zod');

const TIPOS_CREDENCIAL = ['Router', 'Switch', 'AccessPoint', 'NVR', 'DVR', 'Camara', 'Server', 'Firewall', 'ControlAcceso', 'Otro'];

const credencialSchema = z.object({
  clienteId: z.string().uuid(),
  tipo:      z.enum(TIPOS_CREDENCIAL),
  nombre:    z.string().min(1).max(100),
  ip:        z.string().max(60).optional().nullable(),
  usuario:   z.string().min(1).max(80),
  password:  z.string().min(1).max(500),
  notas:     z.string().max(500).optional().nullable(),
});

const listCredencialesQuerySchema = z.object({
  clienteId: z.string().uuid().optional(),
});

module.exports = {
  TIPOS_CREDENCIAL,
  credencialSchema,
  listCredencialesQuerySchema,
};
