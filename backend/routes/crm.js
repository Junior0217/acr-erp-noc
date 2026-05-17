/**
 * backend/routes/crm.js
 *
 * CRM router: clientes, suplidores, prospectos, usuarios-portal, credenciales
 * (vault PAM), activos-cliente (CMDB), timeline.
 * También portal B2C público + autenticado (register/login/dashboard/sos/etc.)
 *
 * Mismo patrón de factory que auth.js (ver comentario allí).
 */

const express = require('express');

function createCrmRouter(deps) {
  const router = express.Router();
  // const { prisma, middlewares, schemas, auditReq, helpers } = deps;
  // const { verificarJWT, verificarPortalJWT, requerirPermiso, requerirTOTPEstricto, vaultCooldownGuard } = middlewares;
  // const { clienteSchema, clienteUpdateSchema, suplidorSchema, suplidorUpdateSchema, prospectoSchema, credencialSchema, activoSchema } = schemas;

  router.get('/_meta/crm-router', (req, res) => res.json({ ok: true, router: 'crm', migrated: 0 }));

  return router;
}

module.exports = createCrmRouter;
