/**
 * backend/modules/ventas/cotizaciones/schema.js
 *
 * Zod DTOs del módulo Cotizaciones. Cubre listado, revivir, listado de
 * facturas (legacy junto a cotizaciones), cambio de estado factura con
 * 2FA umbral, y pipeline Kanban de cotizaciones.
 */

const { z } = require('zod');

const ETAPAS_COT = ['Borrador', 'Enviada', 'Negociacion', 'Aceptada', 'Convertida', 'Perdida'];
const ESTADOS_FACTURA = ['Pagada', 'Anulada', 'Vencida'];

const listCotizacionesQuerySchema = z.object({
  clienteId:     z.string().optional(),
  search:        z.string().optional(),
  clienteCodigo: z.string().optional(),
  clienteNombre: z.string().optional(),
  desde:         z.string().optional(),
  hasta:         z.string().optional(),
  limit:         z.string().optional().default('20'),
  offset:        z.string().optional().default('0'),
});

const revivirSchema = z.object({
  emitir: z.boolean().optional().default(false),
});

const listFacturasQuerySchema = z.object({
  estado:               z.string().optional(),
  clienteId:            z.string().optional(),
  search:               z.string().optional(),
  clienteCodigo:        z.string().optional(),
  clienteNombre:        z.string().optional(),
  desde:                z.string().optional(),
  hasta:                z.string().optional(),
  incluirCotizaciones:  z.enum(['true', 'false']).optional(),
  limit:                z.string().optional().default('50'),
  offset:               z.string().optional().default('0'),
});

const cambiarEstadoFacturaSchema = z.object({
  estado: z.enum(ESTADOS_FACTURA),
  totp:   z.string().optional(),  // requerido si total > UMBRAL_2FA_ANULACION
});

const cambiarEtapaCotizacionSchema = z.object({
  etapa: z.enum(ETAPAS_COT),
});

module.exports = {
  ETAPAS_COT,
  ESTADOS_FACTURA,
  listCotizacionesQuerySchema,
  revivirSchema,
  listFacturasQuerySchema,
  cambiarEstadoFacturaSchema,
  cambiarEtapaCotizacionSchema,
};
