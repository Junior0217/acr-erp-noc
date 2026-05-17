/**
 * backend/modules/auth/schema.js
 *
 * Zod schemas locales al módulo de autenticación. Schemas transversales
 * (passwordSchema reusado por RRHH, etc.) viven en shared/schemas.js y se
 * importan acá para componer.
 *
 * Único DTO permitido por el Blueprint — router/controller/service NUNCA
 * declaran Zod inline.
 */

const { z } = require('zod');
const { passwordSchema } = require('../../shared/schemas');

const loginSchema = z.object({
  email:      z.string().email(),
  cid:        z.string().uuid(),
  ciphertext: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});

const twoFAVerifySchema = z.object({
  tempToken: z.string().uuid(),
  totp:      z.string().min(6).max(20),
});

const totpSixDigitSchema = z.object({
  totp: z.string().length(6),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, 'Contraseña actual requerida.'),
  newPassword:     passwordSchema,
});

const webauthnRegisterVerifySchema = z.object({
  deviceName: z.string().min(2).max(60).optional(),
});

const webauthnLoginOptionsSchema = z.object({
  email: z.string().email().optional(),
});

const webauthnLoginVerifySchema = z.object({
  sessionKey: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
});

module.exports = {
  loginSchema,
  twoFAVerifySchema,
  totpSixDigitSchema,
  passwordChangeSchema,
  webauthnRegisterVerifySchema,
  webauthnLoginOptionsSchema,
  webauthnLoginVerifySchema,
};
