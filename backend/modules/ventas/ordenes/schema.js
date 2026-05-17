/**
 * backend/modules/ventas/ordenes/schema.js
 *
 * Zod DTOs + constantes del módulo Ordenes. Único punto donde se declara
 * validación de input + máquina de estados de OT/OrdenInstalacion/Servicio.
 *
 * Owns:
 *   - Schemas: OT/OI/Servicio/Foto + queries de listado.
 *   - Enums: estados válidos, tipos válidos, SLA por tipo.
 *   - Tablas de transición legal (state machine) consumidas por service.
 */

const { z } = require('zod');
const { nullStr } = require('../../../shared/helpers');

// ─── Enums + constantes ─────────────────────────────────────────────────────
const TIPOS_OT = ['ISP', 'CCTV', 'Reparacion', 'CercoElectrico', 'VentaDirecta', 'General', 'Instalacion', 'Mantenimiento'];
const TIPOS_OI = ['Instalacion', 'Retiro', 'ServicioTecnico', 'Mantenimiento'];
const ESTADOS_OT = ['Pendiente', 'EnProceso', 'Cerrada', 'Cancelada'];
const ESTADOS_SERVICIO = ['Pendiente', 'EnInstalacion', 'Activo', 'Suspendido', 'Cancelado'];
const ESTADOS_OI = ['Pendiente', 'EnProgreso', 'Completada', 'Cancelada'];

const SLA_HORAS_POR_TIPO_OT = {
  Reparacion: 48, Instalacion: 168, CCTV: 168, Mantenimiento: 72,
  General: 24,    ISP: 72,           CercoElectrico: 168, VentaDirecta: 24,
};

// TTL para reservas que crea una OT en estado Pendiente. Si no avanza en 7
// días, cron `expirarReservasOTPendientes` las libera y restaura inventario
// disponible. NO modificar sin recalcular cron.
const OT_RESERVA_TTL_MS = 7 * 86_400_000;

const ESTADO_SERVICIO_POR_TIPO_OI = {
  Instalacion:     'Activo',
  Retiro:          'Cancelado',
  ServicioTecnico: 'Activo',
  Mantenimiento:   'Activo',
};

/**
 * State machine de Orden de Trabajo. Cyber Neo: las transiciones inválidas
 * (ej. Cancelada → Cerrada directo) deben ser rechazadas EN EL SERVICE antes
 * de tocar la DB. La idempotencia (mismo → mismo estado) se acepta como noop.
 *
 *   Pendiente → EnProceso, Cancelada
 *   EnProceso → Pendiente, Cerrada, Cancelada
 *   Cerrada   → ∅ (estado final; revertir solo via endpoint admin separado)
 *   Cancelada → Pendiente (re-activar manualmente; NO va directo a Cerrada)
 */
const TRANSICIONES_OT_VALIDAS = {
  Pendiente: new Set(['EnProceso', 'Cancelada']),
  EnProceso: new Set(['Pendiente', 'Cerrada', 'Cancelada']),
  Cerrada:   new Set([]),
  Cancelada: new Set(['Pendiente']),
};

const TRANSICIONES_SERVICIO_VALIDAS = {
  Pendiente:     new Set(['EnInstalacion', 'Cancelado']),
  EnInstalacion: new Set(['Activo', 'Cancelado']),
  Activo:        new Set(['Suspendido', 'Cancelado']),
  Suspendido:    new Set(['Activo', 'Cancelado']),
  Cancelado:     new Set(['Pendiente']),
};

// ─── Línea de OT ────────────────────────────────────────────────────────────
const lineaOTSchema = z.object({
  itemCatalogoId: z.string().uuid().optional().nullable(),
  productoId:     z.number().int().optional().nullable(),
  descripcion:    z.string().min(1).max(2000),
  cantidad:       z.number().int().min(1).default(1),
  precioUnitario: z.number().min(0),
  // BOM oculto: si true descuenta stock al cerrar OT pero NO se factura.
  consumoInterno: z.boolean().optional().default(false),
});

// ─── Orden de Trabajo (POST /ordenes) ───────────────────────────────────────
const ordenTrabajoSchema = z.object({
  clienteId:           z.string().uuid(),
  tecnicoId:           z.number().int().optional().nullable(),
  tipoOT:              z.enum(TIPOS_OT).default('General'),
  estado:              z.enum(ESTADOS_OT).default('Pendiente'),
  notasTecnicas:       z.string().optional().nullable(),
  metadatos:           z.record(z.unknown()).default({}),
  fotosRequeridas:     z.number().int().min(0).default(0),
  limpiezaRealizada:   z.boolean().default(false),
  fechaVencimientoSLA: z.coerce.date().optional().nullable(),
  garantiaDias:        z.number().int().min(0).optional().nullable(),
  lineas:              z.array(lineaOTSchema).min(1, 'Agrega al menos un item.'),
});

const cambiarEstadoOTSchema = z.object({
  estado:            z.enum(ESTADOS_OT),
  fotosRequeridas:   z.number().int().min(0).optional(),
  limpiezaRealizada: z.boolean().optional(),
  garantiaDias:      z.number().int().min(0).optional(),
});

const listOrdenesQuerySchema = z.object({
  estado:        z.string().optional(),
  tipoOT:        z.string().optional(),
  clienteId:     z.string().optional(),
  tecnicoId:     z.string().optional(),
  search:        z.string().optional(),
  clienteNombre: z.string().optional(),
  desde:         z.string().optional(),
  hasta:         z.string().optional(),
  limit:         z.string().optional().default('50'),
  offset:        z.string().optional().default('0'),
});

// ─── Orden de Instalación (legacy /ordenes-instalacion) ─────────────────────
const detalleOrdenShape = z.object({
  productoId: z.number().int().positive(),
  cantidad:   z.number().int().positive(),
});

const ordenInstalacionSchema = z.object({
  servicioId:  z.string().uuid(),
  tipo:        z.enum(TIPOS_OI),
  tecnicoId:   z.number().int().positive(),
  notas:       nullStr(1000),
  diagnostico: nullStr(2000),
  solucion:    nullStr(2000),
  garantiaDias: z.coerce.number().int().min(0).optional().nullable(),
  detalles:    z.array(detalleOrdenShape).default([]),
});

const ordenInstalacionUpdateSchema = z.object({
  tecnicoId:    z.number().int().positive().optional(),
  notas:        nullStr(1000),
  diagnostico:  nullStr(2000),
  solucion:     nullStr(2000),
  garantiaDias: z.coerce.number().int().min(0).optional().nullable(),
  detalles:     z.array(detalleOrdenShape).optional(),
});

const listOrdenesInstalacionQuerySchema = z.object({
  search: z.string().optional(),
  estado: z.string().optional(),
  tipo:   z.string().optional(),
  page:   z.string().optional().default('1'),
  limit:  z.string().optional().default('50'),
});

// ─── Servicio ───────────────────────────────────────────────────────────────
const servicioSchema = z.object({
  clienteId:            z.string().uuid(),
  planId:               z.string().uuid(),
  estado:               z.enum(ESTADOS_SERVICIO).default('Pendiente'),
  precioMensual:        z.coerce.number().nonnegative().default(0),
  precioInstalacion:    z.coerce.number().nonnegative().default(0),
  notasTecnicas:        nullStr(2000),
  direccionInstalacion: nullStr(300),
  latitud:              nullStr(20),
  longitud:             nullStr(20),
});

const servicioUpdateSchema = servicioSchema.omit({ clienteId: true }).partial();

const cambiarEstadoServicioSchema = z.object({
  estado: z.enum(ESTADOS_SERVICIO),
});

const listServiciosQuerySchema = z.object({
  search:    z.string().optional(),
  estado:    z.string().optional(),
  clienteId: z.string().optional(),
  page:      z.string().optional().default('1'),
  limit:     z.string().optional().default('50'),
});

// ─── Fotos (evidencia anti-fraude) ──────────────────────────────────────────
const ordenFotoSchema = z.object({
  url:         z.string().url().max(1000),
  latitud:     z.string().max(30).optional().nullable(),
  longitud:    z.string().max(30).optional().nullable(),
  descripcion: z.string().max(200).optional().nullable(),
});

const ordenFotoUploadMetaSchema = z.object({
  latitud:     z.string().max(30).optional().nullable(),
  longitud:    z.string().max(30).optional().nullable(),
  descripcion: z.string().max(200).optional().nullable(),
});

module.exports = {
  // enums
  TIPOS_OT,
  TIPOS_OI,
  ESTADOS_OT,
  ESTADOS_OI,
  ESTADOS_SERVICIO,
  SLA_HORAS_POR_TIPO_OT,
  OT_RESERVA_TTL_MS,
  ESTADO_SERVICIO_POR_TIPO_OI,
  TRANSICIONES_OT_VALIDAS,
  TRANSICIONES_SERVICIO_VALIDAS,
  // schemas
  lineaOTSchema,
  ordenTrabajoSchema,
  cambiarEstadoOTSchema,
  listOrdenesQuerySchema,
  detalleOrdenShape,
  ordenInstalacionSchema,
  ordenInstalacionUpdateSchema,
  listOrdenesInstalacionQuerySchema,
  servicioSchema,
  servicioUpdateSchema,
  cambiarEstadoServicioSchema,
  listServiciosQuerySchema,
  ordenFotoSchema,
  ordenFotoUploadMetaSchema,
};
