/**
 * backend/routes/crm.js
 *
 * CRM router: clientes, suplidores, prospectos. Más rutas (portal, vault,
 * activos, timeline, credenciales, usuarios-portal) seguirán migrándose
 * por fases — por ahora el monolito sigue manejándolas.
 */

const express = require('express');
const { z } = require('zod');

function createCrmRouter(deps) {
  const router = express.Router();
  const {
    prisma, middlewares, schemas, auditReq, helpers,
    generarSiguienteCodigo,
  } = deps;
  const { verificarJWT, requerirPermiso } = middlewares;
  const { clienteSchema, clienteUpdateSchema, suplidorSchema, suplidorUpdateSchema, prospectoSchema, prospectoUpdateSchema } = schemas;
  const { validUUID, rejectBadId, formatCliente, formatSuplidor, formatProspecto } = helpers;

  // ─── Clientes ─────────────────────────────────────────────────────────────
  router.get('/clientes', async (req, res) => {
    try {
      const { search, activo, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = { deletedAt: null };
      if (activo !== undefined) where.activo = activo === 'true';
      if (search) {
        where.OR = [
          { razonSocial:    { contains: search, mode: 'insensitive' } },
          { rnc:            { contains: search, mode: 'insensitive' } },
          { noCliente:      { contains: search, mode: 'insensitive' } },
          { nombreContacto: { contains: search, mode: 'insensitive' } },
        ];
      }
      const [clientes, total] = await Promise.all([
        prisma.cliente.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.cliente.count({ where }),
      ]);
      res.json({ data: clientes.map(formatCliente), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch {
      res.status(500).json({ error: 'Error al obtener clientes' });
    }
  });

  router.post('/clientes', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const { prospectoOrigenId, ...body } = req.body;
      const data = clienteSchema.parse(body);
      const cliente = await prisma.$transaction(async (tx) => {
        if (!data.noCliente) data.noCliente = await generarSiguienteCodigo('cliente', tx);
        const c = await tx.cliente.create({ data });
        if (prospectoOrigenId) {
          if (!validUUID(prospectoOrigenId)) throw Object.assign(new Error('prospectoOrigenId inválido.'), { status: 400 });
          await tx.prospecto.update({ where: { id: prospectoOrigenId }, data: { estado: 'Convertido' } });
        }
        return c;
      });
      res.status(201).json(formatCliente(cliente));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de cliente ya existe.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/clientes/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const data = clienteUpdateSchema.parse(req.body);
      const cliente = await prisma.cliente.update({ where: { id: req.params.id }, data });
      res.json(formatCliente(cliente));
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Cliente no encontrado.' });
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC ya existe en otro registro.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.delete('/clientes/:id', verificarJWT, requerirPermiso('crm:borrar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const existing = await prisma.cliente.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.deletedAt) return res.status(404).json({ error: 'Cliente no encontrado.' });
      await prisma.cliente.update({
        where: { id: req.params.id },
        data: { activo: false, deletedAt: new Date() },
      });
      auditReq('crm:cliente_eliminado', req, { clienteId: req.params.id });
      res.status(204).end();
    } catch {
      res.status(500).json({ error: 'Error al eliminar cliente.' });
    }
  });

  router.patch('/clientes/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const current = await prisma.cliente.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Cliente no encontrado.' });
      const updated = await prisma.cliente.update({
        where: { id: req.params.id },
        data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
      });
      res.json(formatCliente(updated));
    } catch {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  });

  // ─── Suplidores ───────────────────────────────────────────────────────────
  router.get('/suplidores', async (req, res) => {
    try {
      const { search, activo, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = {};
      if (activo !== undefined) where.activo = activo === 'true';
      if (search) {
        where.OR = [
          { razonSocial:    { contains: search, mode: 'insensitive' } },
          { rnc:            { contains: search, mode: 'insensitive' } },
          { noSuplidor:     { contains: search, mode: 'insensitive' } },
          { nombreContacto: { contains: search, mode: 'insensitive' } },
        ];
      }
      const [suplidores, total] = await Promise.all([
        prisma.suplidor.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.suplidor.count({ where }),
      ]);
      res.json({ data: suplidores.map(formatSuplidor), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch {
      res.status(500).json({ error: 'Error al obtener suplidores' });
    }
  });

  router.post('/suplidores', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const data = suplidorSchema.parse(req.body);
      res.status(201).json(formatSuplidor(await prisma.suplidor.create({ data })));
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC o número de suplidor ya existe.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/suplidores/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const data = suplidorUpdateSchema.parse(req.body);
      const suplidor = await prisma.suplidor.update({ where: { id: req.params.id }, data });
      res.json(formatSuplidor(suplidor));
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Suplidor no encontrado.' });
      if (error.code === 'P2002') return res.status(409).json({ error: 'El RNC ya existe en otro registro.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.patch('/suplidores/:id/toggle', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const current = await prisma.suplidor.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Suplidor no encontrado.' });
      const updated = await prisma.suplidor.update({
        where: { id: req.params.id },
        data: { activo: !current.activo, fechaInactivo: !current.activo ? null : new Date() },
      });
      res.json(formatSuplidor(updated));
    } catch {
      res.status(500).json({ error: 'Error al cambiar estado' });
    }
  });

  // ─── Prospectos ───────────────────────────────────────────────────────────
  router.get('/prospectos', async (req, res) => {
    try {
      const { search, estado, page = '1', limit = '50' } = req.query;
      const take = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
      const pageNum = Math.max(parseInt(page) || 1, 1);
      const skip = (pageNum - 1) * take;
      const where = {};
      if (estado) where.estado = estado;
      if (search) {
        where.OR = [
          { nombre:   { contains: search, mode: 'insensitive' } },
          { telefono: { contains: search, mode: 'insensitive' } },
        ];
      }
      const [prospectos, total] = await Promise.all([
        prisma.prospecto.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.prospecto.count({ where }),
      ]);
      res.json({ data: prospectos.map(formatProspecto), meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } });
    } catch {
      res.status(500).json({ error: 'Error al obtener prospectos' });
    }
  });

  router.post('/prospectos', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    try {
      const data = prospectoSchema.parse(req.body);
      res.status(201).json(formatProspecto(await prisma.prospecto.create({ data })));
    } catch {
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.put('/prospectos/:id', verificarJWT, requerirPermiso('crm:editar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const data = prospectoUpdateSchema.parse(req.body);
      const prospecto = await prisma.prospecto.update({ where: { id: req.params.id }, data });
      res.json(formatProspecto(prospecto));
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Prospecto no encontrado.' });
      res.status(400).json({ error: 'Datos inválidos' });
    }
  });

  router.delete('/prospectos/:id', verificarJWT, requerirPermiso('crm:borrar'), async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      await prisma.prospecto.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (error) {
      if (error.code === 'P2025') return res.status(404).json({ error: 'Prospecto no encontrado.' });
      res.status(500).json({ error: 'Error al eliminar prospecto' });
    }
  });

  router.patch('/prospectos/:id/convertir', verificarJWT, async (req, res) => {
    if (rejectBadId(req, res)) return;
    try {
      const prospecto = await prisma.prospecto.findUnique({ where: { id: req.params.id } });
      if (!prospecto) return res.status(404).json({ error: 'Prospecto no encontrado.' });
      if (prospecto.estado === 'Convertido') return res.status(409).json({ error: 'Prospecto ya fue convertido.' });

      const count = await prisma.cliente.count({ where: { deletedAt: null } });
      const noCliente = `CLI-${String(count + 1).padStart(4, '0')}`;

      const resultado = await prisma.$transaction(async (tx) => {
        const cliente = await tx.cliente.create({
          data: {
            noCliente,
            razonSocial:       prospecto.nombre,
            telefonoPrincipal: prospecto.telefono,
            latitud:           prospecto.latitud  ?? undefined,
            longitud:          prospecto.longitud ?? undefined,
            notas:             prospecto.notas    ?? undefined,
            tipoCliente:       'Residencial',
          },
        });
        const updated = await tx.prospecto.update({
          where: { id: req.params.id },
          data:  { estado: 'Convertido' },
        });
        return { cliente, prospecto: updated };
      });

      res.json({
        cliente:   formatCliente(resultado.cliente),
        prospecto: formatProspecto(resultado.prospecto),
      });
    } catch (error) {
      console.error('[CONVERTIR PROSPECTO]', error.message);
      res.status(500).json({ error: 'Error al convertir prospecto' });
    }
  });

  return router;
}

module.exports = createCrmRouter;
