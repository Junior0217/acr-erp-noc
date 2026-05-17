/**
 * backend/shared/schemas.js
 *
 * Zod schemas reusados por routers + server.js. Mantienen la convención:
 * - *Schema      : validador full (POST/CREATE)
 * - *UpdateSchema: validador parcial (PATCH/PUT)
 * - *BaseShape   : forma cruda sin refinements (para extender)
 *
 * Validadores cross-field (RNC OR Cédula obligatorio) se aplican via superRefine.
 */

const { z } = require('zod');
const { emptyStr, nullStr, optIdent, optCedulaRD } = require('./helpers');

const passwordSchema = z.string()
  .min(8, 'Mínimo 8 caracteres.')
  .regex(/[^a-zA-Z0-9\s]/, 'Requiere al menos un símbolo especial (ej. ! @ # $ % & *).');

const empleadoSchema = z.object({
  nombre:   z.string().min(2).max(100),
  email:    z.string().email().trim(),
  roleIds:  z.array(z.number().int().positive()).optional().default([]),
  password: passwordSchema,
});

const empleadoUpdateSchema = z.object({
  nombre:   z.string().min(2).max(100).optional(),
  email:    z.string().email().trim().optional(),
  roleIds:  z.array(z.number().int().positive()).optional(),
  password: z.union([passwordSchema, z.literal('')])
              .optional()
              .transform(v => (v === '' || v == null) ? undefined : v),
});

const asistenciaSchema = z.object({
  empleadoId: z.number().int().positive(),
  tipo:       z.enum(['Entrada', 'Salida']),
  latitud:    z.string().max(30).optional().nullable(),
  longitud:   z.string().max(30).optional().nullable(),
});

const clienteBaseShape = z.object({
  noCliente:           z.string().min(1).max(20).optional(),
  razonSocial:         z.string().min(2).max(200),
  nombreComercial:     nullStr(100),
  rnc:                 optIdent(20),
  registroMercantil:   nullStr(30),
  tipoEmpresa:         z.string().min(1).max(30),
  fechaInicio:         z.coerce.date().optional(),
  nombreContacto:      z.string().min(2).max(100),
  apellidoContacto:    nullStr(100),
  cedula:              optCedulaRD,
  cargo:               nullStr(80),
  direccion:           z.string().min(2).max(300),
  sector:              z.string().min(1).max(100),
  provincia:           z.string().min(1).max(100),
  telefonoPrincipal:   z.string().max(20).optional().nullable().transform(v => (v == null || v === '') ? null : v),
  telefonoAlternativo: nullStr(20),
  email:               z.string().email().trim(),
  website:             nullStr(100),
  tipoCliente:         z.string().min(1).max(50),
  itbis:               z.boolean().default(true),
  promHorasMes:        z.number().int().min(0).max(744).optional(),
  latitud:             nullStr(20),
  longitud:            nullStr(20),
  activo:              z.boolean().default(true),
  fechaInactivo:       z.coerce.date().optional(),
  limiteCredito:       z.coerce.number().nonnegative().default(0),
  diasCredito:         z.coerce.number().int().min(0).default(0),
  tipoNcf:             z.string().default('Consumidor Final'),
});

const clienteSchema = clienteBaseShape.superRefine((data, ctx) => {
  if (!data.rnc && !data.cedula) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'RNC o Cédula es obligatorio.', path: ['rnc'] });
  }
});

const clienteUpdateSchema = clienteBaseShape.omit({ noCliente: true }).partial();

const suplidorBaseShape = z.object({
  noSuplidor:        z.string().min(1).max(20),
  razonSocial:       z.string().min(2).max(200),
  nombreComercial:   nullStr(100),
  rnc:               optIdent(20),
  direccion:         z.string().min(2).max(300),
  sector:            z.string().min(1).max(100),
  provincia:         z.string().min(1).max(100),
  latitud:           nullStr(20),
  longitud:          nullStr(20),
  nombreContacto:    z.string().min(2).max(100),
  cedula:            optCedulaRD,
  cargo:             nullStr(80),
  telefonoPrincipal: z.string().min(7).max(20),
  telefonoAlt:       nullStr(20),
  email:             z.string().email().trim().or(emptyStr).optional().transform(v => (v === '' || v == null) ? null : v),
  contactoAlt:       nullStr(150),
  actividad:         z.string().min(1).max(100),
  camposUsuario:     nullStr(500),
  fechaInicio:       z.coerce.date().optional(),
  activo:            z.boolean().default(true),
  fechaInactivo:     z.coerce.date().optional(),
  limiteCredito:     z.coerce.number().nonnegative().default(0),
  diasCredito:       z.coerce.number().int().min(0).default(0),
});

const suplidorSchema = suplidorBaseShape.superRefine((data, ctx) => {
  if (!data.rnc && !data.cedula) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'RNC o Cédula es obligatorio.', path: ['rnc'] });
  }
});

const suplidorUpdateSchema = suplidorBaseShape.omit({ noSuplidor: true }).partial();

const prospectoSchema = z.object({
  nombre:             z.string().min(2).max(150),
  telefono:           z.string().min(7).max(20),
  servicioInteresado: z.string().min(1).max(100),
  origen:             z.enum(['WhatsApp', 'Llamada', 'Referido', 'Web', 'Presencial', 'Otro']).default('WhatsApp'),
  notas:              nullStr(1000),
  latitud:            nullStr(20),
  longitud:           nullStr(20),
  estado:             z.enum(['Nuevo', 'Contactado', 'Interesado', 'Negociación', 'Perdido', 'Convertido']).default('Nuevo'),
});

const prospectoUpdateSchema = prospectoSchema.partial();

const portalRegisterSchema = z.object({
  nombre:   z.string().min(2).max(200),
  email:    z.string().email().trim().toLowerCase(),
  password: z.string().min(6).max(100),
});

const portalLoginSchema = z.object({
  email:    z.string().email().trim().toLowerCase(),
  password: z.string().min(1),
});

const credencialSchema = z.object({
  clienteId: z.string().uuid(),
  tipo:      z.enum(['Router','Switch','AccessPoint','NVR','DVR','Camara','Server','Firewall','ControlAcceso','Otro']),
  nombre:    z.string().min(1).max(100),
  ip:        z.string().max(60).optional().nullable(),
  usuario:   z.string().min(1).max(80),
  password:  z.string().min(1).max(500),
  notas:     z.string().max(500).optional().nullable(),
});

const activoSchema = z.object({
  clienteId:        z.string().uuid(),
  productoId:       z.number().int().positive(),
  cantidad:         z.number().int().min(1).default(1),
  fechaInstalacion: z.coerce.date().optional(),
  finGarantia:      z.coerce.date().optional().nullable(),
  numeroSerie:      z.string().max(80).optional().nullable(),
  ubicacion:        z.string().max(150).optional().nullable(),
  notas:            z.string().max(500).optional().nullable(),
});

const prestamoSchema = z.object({
  clienteId:  z.string().uuid(),
  productoId: z.number().int().positive(),
  cantidad:   z.number().int().min(1).default(1),
  diasLimite: z.number().int().min(1).max(180).default(15),
  notas:      z.string().max(500).optional().nullable(),
});

const ticketTallerSchema = z.object({
  clienteId:     z.string().uuid(),
  tecnicoId:     z.number().int().optional().nullable(),
  equipo:        z.string().min(1).max(150),
  marca:         z.string().max(80).optional().nullable(),
  modelo:        z.string().max(80).optional().nullable(),
  numeroSerie:   z.string().max(80).optional().nullable(),
  falla:         z.string().min(1).max(1000),
  notas:         z.string().max(1000).optional().nullable(),
  costoEstimado: z.coerce.number().nonnegative().optional().nullable(),
});

const ticketEstadoSchema = z.object({
  estado:       z.enum(['Recibido','Diagnostico','EsperandoPieza','Listo','Entregado','Cancelado']),
  diagnostico:  z.string().max(2000).optional().nullable(),
  costoEstimado: z.coerce.number().nonnegative().optional().nullable(),
  notas:        z.string().max(1000).optional().nullable(),
});

const ordenFotoSchema = z.object({
  url:         z.string().url().max(1000),
  latitud:     z.string().max(30).optional().nullable(),
  longitud:    z.string().max(30).optional().nullable(),
  descripcion: z.string().max(200).optional().nullable(),
});

const timelineEventoSchema = z.object({
  evento:         z.enum(['instalado','reparado','trasladado','retirado','garantia_reclamada','mantenimiento','inspeccion']),
  ordenTrabajoId: z.string().uuid().optional().nullable(),
  notas:          z.string().max(500).optional().nullable(),
});

const checkoutSchema = z.object({
  items: z.array(z.object({
    itemCatalogoId: z.string().uuid(),
    cantidad:       z.number().int().min(1).max(99),
  })).min(1).max(50),
  metodoPago: z.enum(['Tarjeta','Transferencia']).default('Tarjeta'),
});

const azulWebhookSchema = z.object({
  paymentRef:    z.string().uuid(),
  estadoPago:    z.enum(['aprobado','rechazado','reversado']),
  transactionId: z.string().min(1).max(120),
  monto:         z.coerce.number().positive(),
  fechaPago:     z.coerce.date().optional(),
});

module.exports = {
  passwordSchema,
  empleadoSchema,
  empleadoUpdateSchema,
  asistenciaSchema,
  clienteBaseShape,
  clienteSchema,
  clienteUpdateSchema,
  suplidorBaseShape,
  suplidorSchema,
  suplidorUpdateSchema,
  prospectoSchema,
  prospectoUpdateSchema,
  portalRegisterSchema,
  portalLoginSchema,
  credencialSchema,
  activoSchema,
  prestamoSchema,
  ticketTallerSchema,
  ticketEstadoSchema,
  ordenFotoSchema,
  timelineEventoSchema,
  checkoutSchema,
  azulWebhookSchema,
};
