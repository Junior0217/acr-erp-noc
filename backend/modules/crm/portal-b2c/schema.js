/**
 * backend/modules/crm/portal-b2c/schema.js
 *
 * Zod DTOs del módulo Portal B2C. Interfaz PÚBLICA — Cyber Neo audita:
 *   - Email validado y NORMALIZADO (trim+lowercase) en register/login/forgot.
 *   - Password min 6 / max 100 (consistente con UI; hashed bcrypt cost 12).
 *   - Token reset: hex 64 chars exactos.
 *   - SOS descripción max 500 (anti DoS).
 *   - Cotización portal: max 50 líneas, cant max 999, descuentoPct max 100.
 *   - Checkout: max 50 items.
 */

const { z } = require('zod');

const portalRegisterSchema = z.object({
  nombre:   z.string().min(2).max(200),
  email:    z.string().email().trim().toLowerCase(),
  password: z.string().min(6).max(100),
});

const portalLoginSchema = z.object({
  email:    z.string().email().trim().toLowerCase(),
  password: z.string().min(1),
});

const settingsSchema = z.object({
  mostrarEquipos:   z.boolean().optional(),
  permitirPagos:    z.boolean().optional(),
  mostrarMapa:      z.boolean().optional(),
  mostrarCotizador: z.boolean().optional(),
  mostrarServicios: z.boolean().optional(),
});

const forgotSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
});

const resetSchema = z.object({
  token:    z.string().length(64),
  password: z.string().min(6).max(100),
});

const sosSchema = z.object({
  descripcion: z.string().max(500).optional(),
});

const portalCotizacionSchema = z.object({
  lineas: z.array(z.object({
    nombre:    z.string().min(1).max(200),
    precio:    z.number().positive(),
    cantidad:  z.number().int().min(1).max(999),
    categoria: z.string().optional(),
  })).min(1).max(50),
  descuentoPct: z.number().min(0).max(100).optional().default(0),
  notas:        z.string().max(500).optional(),
});

const checkoutSchema = z.object({
  items: z.array(z.object({
    itemCatalogoId: z.string().uuid(),
    cantidad:       z.number().int().min(1).max(99),
  })).min(1).max(50),
  metodoPago: z.enum(['Tarjeta', 'Transferencia']).default('Tarjeta'),
});

const azulWebhookSchema = z.object({
  paymentRef:    z.string().uuid(),
  estadoPago:    z.enum(['aprobado', 'rechazado', 'reversado']),
  transactionId: z.string().min(1).max(120),
  monto:         z.coerce.number().positive(),
  fechaPago:     z.coerce.date().optional(),
});

const portalCatalogQuerySchema = z.object({
  categoria: z.string().optional(),
  tipo:      z.string().optional(),
  search:    z.string().optional(),
});

module.exports = {
  portalRegisterSchema, portalLoginSchema, settingsSchema,
  forgotSchema, resetSchema, sosSchema,
  portalCotizacionSchema, checkoutSchema, azulWebhookSchema,
  portalCatalogQuerySchema,
};
