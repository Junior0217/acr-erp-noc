/**
 * backend/modules/servicios/ordenes/schema.js
 *
 * Zod DTOs del módulo Órdenes de Servicio Técnico (CCTV, impresoras,
 * servidores, PC, redes, reparación física). Foco exclusivo: soporte
 * técnico e infraestructura — NO contratos ISP / WISP.
 *
 * Persistencia: reutiliza el modelo Prisma OrdenTrabajo con
 * tipoOT = 'ServicioTecnico' y metadatos JSON para los campos
 * específicos del flujo (tipoEquipo, marca, modelo, serial,
 * diagnostico inicial, reporte técnico, piezas, presupuesto).
 */

const { z } = require('zod');

// ─── Estados del flujo técnico (state machine) ───────────────────────────────
const ESTADOS_OT_SERVICIO = [
  'Recibido en Taller',
  'En Diagnóstico',
  'Presupuestado',
  'En Reparación',
  'Listo para Entrega',
  'Entregado/Facturado',
];

const ESTADO_INICIAL = 'Recibido en Taller';
const ESTADO_TERMINAL = 'Entregado/Facturado';

// Transiciones válidas. Clave = estado actual; valor = array de
// estados a los que se puede saltar.
const TRANSICIONES_VALIDAS = {
  'Recibido en Taller':   ['En Diagnóstico'],
  'En Diagnóstico':       ['Presupuestado'],
  'Presupuestado':        ['En Reparación', 'Recibido en Taller'], // permite rechazo del cliente
  'En Reparación':        ['Listo para Entrega'],
  'Listo para Entrega':   ['Entregado/Facturado'],
  'Entregado/Facturado':  [], // terminal — inmutable
};

// ─── Taxonomía de equipos (foco Registro Mercantil) ─────────────────────────
const TIPOS_EQUIPO = [
  'Cámara',
  'NVR',
  'DVR',
  'Impresora',
  'Servidor',
  'PC',
  'Laptop',
  'Switch',
  'Router',
  'Access Point',
  'UPS',
  'Cerco Eléctrico',
  'Otro',
];

// ─── Helpers reutilizables ───────────────────────────────────────────────────
const emptyStr = z.literal('').transform(() => null);
const nullableTrimmed = (max) =>
  z.union([emptyStr, z.string().trim().min(1).max(max)]).nullable().optional();

const piezaUtilizadaSchema = z.object({
  productoId:     z.number().int().positive().nullable().optional(),
  descripcion:    z.string().trim().min(1).max(200),
  cantidad:       z.coerce.number().int().positive().default(1),
  precioUnitario: z.coerce.number().nonnegative().default(0),
});

// ─── DTOs ────────────────────────────────────────────────────────────────────

const crearOrdenSchema = z.object({
  clienteId:          z.string().uuid(),
  tecnicoId:          z.number().int().positive().nullable().optional(),
  tipoEquipo:         z.enum(TIPOS_EQUIPO),
  marca:              nullableTrimmed(80),
  modelo:             nullableTrimmed(80),
  serial:             nullableTrimmed(80),
  diagnosticoInicial: z.string().trim().min(1).max(2000),
  notas:              nullableTrimmed(1000),
});

const actualizarOrdenSchema = z.object({
  tecnicoId:           z.number().int().positive().nullable().optional(),
  tipoEquipo:          z.enum(TIPOS_EQUIPO).optional(),
  marca:               nullableTrimmed(80),
  modelo:              nullableTrimmed(80),
  serial:              nullableTrimmed(80),
  diagnosticoInicial:  z.string().trim().min(1).max(2000).optional(),
  reporteTecnicoFinal: nullableTrimmed(4000),
  piezasUtilizadas:    z.array(piezaUtilizadaSchema).max(50).optional(),
  presupuestoMonto:    z.coerce.number().nonnegative().nullable().optional(),
  notas:               nullableTrimmed(1000),
}).strict();

const cambiarEstadoSchema = z.object({
  estado:              z.enum(ESTADOS_OT_SERVICIO),
  reporteTecnicoFinal: nullableTrimmed(4000),
  presupuestoMonto:    z.coerce.number().nonnegative().nullable().optional(),
  piezasUtilizadas:    z.array(piezaUtilizadaSchema).max(50).optional(),
  notas:               nullableTrimmed(1000),
});

const facturarOrdenSchema = z.object({
  diasVence:           z.coerce.number().int().nonnegative().default(0),
  metodoPago:          z.string().trim().min(1).max(40).default('Efectivo'),
  refer:               nullableTrimmed(80),
  tipoNcfOverride:     z.enum(['Fiscal', 'Consumidor Final']).optional(),
  pinSupervisor:       nullableTrimmed(20),
});

const listOrdenesQuerySchema = z.object({
  clienteId:  z.string().uuid().optional(),
  estado:     z.enum(ESTADOS_OT_SERVICIO).optional(),
  tipoEquipo: z.enum(TIPOS_EQUIPO).optional(),
  search:     z.string().max(200).optional(),
  desde:      z.string().optional(),
  hasta:      z.string().optional(),
  limit:      z.coerce.number().int().positive().max(200).default(50),
  offset:     z.coerce.number().int().nonnegative().default(0),
});

module.exports = {
  ESTADOS_OT_SERVICIO,
  ESTADO_INICIAL,
  ESTADO_TERMINAL,
  TRANSICIONES_VALIDAS,
  TIPOS_EQUIPO,
  piezaUtilizadaSchema,
  crearOrdenSchema,
  actualizarOrdenSchema,
  cambiarEstadoSchema,
  facturarOrdenSchema,
  listOrdenesQuerySchema,
};
