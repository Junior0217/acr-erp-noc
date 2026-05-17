/**
 * backend/modules/ventas/catalogo/controller.js
 *
 * Capa HTTP del módulo Catálogo. Thin handlers + Zod + _wrap.
 *
 * Factory: createCatalogoController({ service, schemas, prisma, helpers })
 */

const { z } = require('zod');
const { CatalogoError } = require('./service');

function _extractReqMeta(req) {
  return {
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null,
    ua: req.headers?.['user-agent'] ?? '',
  };
}

function _wrap(fn) {
  return async function wrapped(req, res) {
    try {
      const d = await fn(req, res);
      if (!res.headersSent) {
        const status = d?.status ?? 200;
        if (d?.body == null && (status === 204 || status === 205)) return res.status(status).end();
        return res.status(status).json(d?.body ?? {});
      }
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues?.[0]?.message ?? 'Datos inválidos.' });
      if (err instanceof CatalogoError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[CATALOGO CTRL]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  };
}

function createCatalogoController({ service, schemas, prisma, helpers }) {
  if (!service) throw new Error('createCatalogoController: service required');
  if (!schemas) throw new Error('createCatalogoController: schemas required');
  if (!prisma)  throw new Error('createCatalogoController: prisma required');
  if (!helpers) throw new Error('createCatalogoController: helpers required');
  const {
    itemCatalogoSchema, catalogoBuscarQuerySchema, listCatalogoQuerySchema,
    planSchema, planUpdateSchema, listPlanesQuerySchema,
  } = schemas;
  const { rejectBadId } = helpers;

  const buscar = _wrap(async (req) => {
    const q = catalogoBuscarQuerySchema.parse(req.query);
    return service.buscarUnificado(q);
  });

  const listCatalogo = _wrap(async (req) => {
    const q = listCatalogoQuerySchema.parse(req.query);
    return service.listarCatalogo(q, req.user);
  });

  const postItem = _wrap(async (req) => {
    const dto     = itemCatalogoSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.crearItemCatalogo(dto, req.user, reqMeta);
  });

  const putItem = _wrap(async (req) => {
    const dto     = itemCatalogoSchema.parse(req.body);
    const reqMeta = _extractReqMeta(req);
    return service.actualizarItemCatalogo(req.params.id, dto, req.user, reqMeta);
  });

  const deleteItem = _wrap(async (req) => service.eliminarItemCatalogo(req.params.id));

  // Planes
  const listPlanes = _wrap(async (req) => {
    const q = listPlanesQuerySchema.parse(req.query);
    return service.listarPlanes(q);
  });
  const getPlan = _wrap(async (req, res) => { if (rejectBadId(req, res)) return; return service.getPlan(req.params.id); });
  const postPlan = _wrap(async (req) => {
    const dto = planSchema.parse(req.body);
    return service.crearPlan(dto, { prisma });
  });
  const putPlan = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    const dto = planUpdateSchema.parse(req.body);
    return service.actualizarPlan(req.params.id, dto, { prisma });
  });
  const togglePlan = _wrap(async (req, res) => {
    if (rejectBadId(req, res)) return;
    return service.togglePlan(req.params.id);
  });

  // Publicos / portal / bundles
  const getCatalogoPublico = _wrap(async () => service.listarCatalogoPublico());
  const getPortalCatalogo  = _wrap(async () => service.listarCatalogoPortal());
  const getBundlesProducto = _wrap(async (req) => service.getBundlesPorProducto(req.params.id));
  const getBundlesItem     = _wrap(async (req) => service.getBundlesPorItemCatalogo(req.params.id, helpers));

  return {
    buscar, listCatalogo, postItem, putItem, deleteItem,
    listPlanes, getPlan, postPlan, putPlan, togglePlan,
    getCatalogoPublico, getPortalCatalogo,
    getBundlesProducto, getBundlesItem,
  };
}

module.exports = createCatalogoController;
