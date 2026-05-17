/**
 * backend/modules/admin/empresa/schema.js
 *
 * DTOs del módulo Empresa (perfil, secuencias, upload).
 */

const { z } = require('zod');

function createEmpresaSchemas({ validarCedulaRD, esAssetUrlSegura }) {
  if (typeof validarCedulaRD !== 'function')   throw new Error('createEmpresaSchemas: validarCedulaRD required');
  if (typeof esAssetUrlSegura !== 'function')  throw new Error('createEmpresaSchemas: esAssetUrlSegura required');

  const secuenciaEntradaSchema = z.object({
    prefijo: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Solo mayúsculas y dígitos.'),
    actual:  z.coerce.number().int().min(0).max(99_999_999),
    padding: z.coerce.number().int().min(3).max(10),
  });

  const secuenciasPatchSchema = z.object({
    factura:    secuenciaEntradaSchema.optional(),
    cotizacion: secuenciaEntradaSchema.optional(),
    producto:   secuenciaEntradaSchema.optional(),
    servicio:   secuenciaEntradaSchema.optional(),
    cliente:    secuenciaEntradaSchema.optional(),
    rma:        secuenciaEntradaSchema.optional(),
    plan:       secuenciaEntradaSchema.optional(),
  }).strict();

  const empresaPatchSchema = z.object({
    rnc:                   z.string().min(9).max(20).optional(),
    razonSocial:           z.string().min(2).max(200).optional(),
    nombreComercial:       z.string().max(200).optional().nullable(),
    registroMercantil:     z.string().max(50).optional().nullable(),
    representanteNombre:   z.string().max(100).optional().nullable(),
    representanteApellido: z.string().max(100).optional().nullable(),
    representanteCedula:   z.string().max(20).optional().nullable().refine(
      v => !v || validarCedulaRD(v),
      { message: 'Cédula RD inválida (dígito verificador no coincide).' }
    ),
    representanteCargo:    z.string().max(80).optional().nullable(),
    direccion:             z.string().max(300).optional().nullable(),
    sector:                z.string().max(100).optional().nullable(),
    provincia:             z.string().max(100).optional().nullable(),
    pais:                  z.string().max(80).optional(),
    tipoEmpresa:           z.string().max(40).optional().nullable(),
    fechaInicio:           z.coerce.date().optional().nullable(),
    telefono:              z.string().max(80).optional().nullable(),
    fax:                   z.string().max(40).optional().nullable(),
    email:                 z.string().email().max(150).optional().nullable().or(z.literal('').transform(() => null)),
    website:               z.string().max(200).optional().nullable().or(z.literal('').transform(() => null)),
    assets: z.object({
      logoClaro:    z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
      logoOscuro:   z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
      selloFisico:  z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
      firmaGerente: z.string().max(500).optional().nullable().refine(esAssetUrlSegura, { message: 'URL fuera de whitelist (Supabase Storage / local).' }),
    }).partial().optional(),
    eslogan:               z.string().max(200).optional().nullable(),
    pinSupervisor:         z.string().min(4).max(8).regex(/^\d+$/, 'Solo dígitos.').optional(),
    maxDescuentoCajero:    z.coerce.number().int().min(0).max(100).optional(),
    condicionesDefault: z.object({
      validez:      z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
      pago:         z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
      entrega:      z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
      garantia:     z.string().max(280).optional().nullable().or(z.literal('').transform(() => null)),
      _obligatorio: z.object({
        validez:  z.boolean().optional(),
        pago:     z.boolean().optional(),
        entrega:  z.boolean().optional(),
        garantia: z.boolean().optional(),
      }).partial().optional(),
    }).partial().optional(),
  });

  const previewParamsSchema = z.object({
    entidad: z.string().min(1).max(40),
  });

  return {
    secuenciaEntradaSchema,
    secuenciasPatchSchema,
    empresaPatchSchema,
    previewParamsSchema,
  };
}

module.exports = createEmpresaSchemas;
