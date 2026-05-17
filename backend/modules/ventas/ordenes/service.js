/**
 * backend/modules/ventas/ordenes/service.js
 *
 * Lógica de negocio del módulo Ordenes. NO conoce req/res. Recibe DTOs
 * planos + reqMeta + user.
 *
 * Owns:
 *   - State machine de OT (TRANSICIONES_OT_VALIDAS) — _validarTransicionOT.
 *   - State machine de Servicio (TRANSICIONES_SERVICIO_VALIDAS).
 *   - Crear OT con reservas BOM-expandidas.
 *   - Cerrar OT: consume reservas atómicamente + crea ActivoCliente + audita
 *     stock drift. Anti-fraude: bloquea cierre si fotosRequeridas > fotos.
 *   - OrdenInstalacion: completar con ajuste de stock + sincronización de
 *     estado de Servicio (vía ESTADO_SERVICIO_POR_TIPO_OI).
 *   - Servicios: CRUD + state machine.
 *   - Fotos: upload multipart (Supabase + sharp + EXIF strip), URL JSON,
 *     listado, delete con guard de OT inmutable.
 *
 * Factory: createOrdenesService({ repo, auditReq, supabase, MIME_EXT,
 *   detectMimeFromBuffer, comprimirImagen, nextNomenclatura,
 *   generarSiguienteCodigo, OT_FOTOS_BUCKET })
 *
 * CRÍTICO — Cyber Neo (auditoría de estados + archivos):
 * - Transiciones OT/Servicio bloqueadas por _validarTransicion* ANTES de
 *   tocar DB. Cancelada → Cerrada directo = throw TRANSICION_INVALIDA 409.
 * - Foto upload path: `${otId}/${ts}-${rand}.${ext}` — otId es UUID (no
 *   input usuario, viene de findUnique), timestamp y randomBytes(4) no
 *   editables. Cero string concat de req.* en el path = path traversal
 *   imposible.
 * - SVG explicitamente rechazado en uploads de OT (anti XSS embebido).
 * - Sharp strip EXIF: GPS embebido por la cámara se descarta — privacidad
 *   del cliente preservada cuando el técnico sube foto desde un Android.
 */

const crypto = require('crypto');
const {
  SLA_HORAS_POR_TIPO_OT,
  OT_RESERVA_TTL_MS,
  TRANSICIONES_OT_VALIDAS,
  TRANSICIONES_SERVICIO_VALIDAS,
  ESTADO_SERVICIO_POR_TIPO_OI,
} = require('./schema');

class OtError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code   = code;
    if (extra) this.extra = extra;
  }
}

function createOrdenesService(deps) {
  const {
    repo, auditReq,
    supabase, OT_FOTOS_BUCKET,
    detectMimeFromBuffer, comprimirImagen,
    nextNomenclatura, generarSiguienteCodigo,
  } = deps;
  if (!repo)                                      throw new Error('createOrdenesService: repo required');
  if (typeof auditReq !== 'function')             throw new Error('createOrdenesService: auditReq required');
  if (typeof nextNomenclatura !== 'function')     throw new Error('createOrdenesService: nextNomenclatura required');
  if (typeof generarSiguienteCodigo !== 'function') throw new Error('createOrdenesService: generarSiguienteCodigo required');
  if (!OT_FOTOS_BUCKET)                           throw new Error('createOrdenesService: OT_FOTOS_BUCKET required');

  function _fakeReqForAudit(reqMeta, user) {
    return {
      headers: {
        'x-forwarded-for': reqMeta?.ip ?? null,
        'user-agent':      reqMeta?.ua ?? null,
      },
      socket: { remoteAddress: reqMeta?.ip ?? null },
      user:   user ?? null,
    };
  }

  function _formatServicio(s) {
    return {
      ...s,
      precioMensual:     Number(s.precioMensual),
      precioInstalacion: Number(s.precioInstalacion),
    };
  }

  function _validarTransicionOT(actual, nuevo) {
    if (actual === nuevo) return; // idempotente
    const permitidos = TRANSICIONES_OT_VALIDAS[actual];
    if (!permitidos || !permitidos.has(nuevo)) {
      throw new OtError(409, 'TRANSICION_INVALIDA',
        `Transición ${actual} → ${nuevo} no permitida. Estados desde "${actual}": ${[...(permitidos ?? [])].join(', ') || '∅ (estado final)'}.`);
    }
  }

  function _validarTransicionServicio(actual, nuevo) {
    if (actual === nuevo) return;
    const permitidos = TRANSICIONES_SERVICIO_VALIDAS[actual];
    if (!permitidos || !permitidos.has(nuevo)) {
      throw new OtError(409, 'TRANSICION_SERVICIO_INVALIDA',
        `Transición de servicio ${actual} → ${nuevo} no permitida.`);
    }
  }

  /**
   * BOM expansion local. Expande una línea a {productoId, cantidad}[].
   * Misma lógica que pos/service para mantener invariantes idénticas
   * (productos directos, bundles, items vinculados, servicios puros).
   */
  async function expandirLineaAComponentes(tx, linea) {
    if (!linea || typeof linea !== 'object') return [];
    const cantidad = Number(linea.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return [];
    if (linea.productoId) {
      return [{ productoId: linea.productoId, cantidad, source: 'direct' }];
    }
    if (linea.itemCatalogoId) {
      let it;
      try {
        it = await repo.findItemCatalogoForExpansion(tx, linea.itemCatalogoId);
      } catch (e) {
        console.warn(`[OT expandir] lookup falló id=${linea.itemCatalogoId}:`, e.message);
        return [];
      }
      if (!it) return [];
      if (it.esBundle && Array.isArray(it.componentes) && it.componentes.length > 0) {
        return it.componentes
          .filter(c => c?.producto && c.producto.tipoItem !== 'SERVICIO' && Number(c.cantidad) > 0)
          .map(c => ({
            productoId:   c.productoId,
            cantidad:     Number(c.cantidad) * cantidad,
            nombre:       c.producto.nombre ?? 'Componente',
            source:       'bundle',
            bundleItemId: it.id,
          }));
      }
      if (it.productoId && it.producto?.tipoItem !== 'SERVICIO') {
        return [{
          productoId: it.productoId,
          cantidad,
          nombre:     it.producto?.nombre ?? it.nombre ?? 'Producto',
          source:     'linked',
        }];
      }
    }
    return [];
  }

  // ─── OT: listar ──────────────────────────────────────────────────────────
  async function listarOrdenesTrabajo(query) {
    const where = { deletedAt: null };
    if (query.estado)        where.estado    = query.estado;
    if (query.tipoOT)        where.tipoOT    = query.tipoOT;
    if (query.clienteId)     where.clienteId = query.clienteId;
    if (query.tecnicoId)     where.tecnicoId = parseInt(query.tecnicoId, 10);
    if (query.search)        where.noOT      = { contains: query.search, mode: 'insensitive' };
    if (query.clienteNombre) where.cliente   = { razonSocial: { contains: query.clienteNombre, mode: 'insensitive' } };
    if (query.desde || query.hasta) {
      where.createdAt = {};
      if (query.desde) where.createdAt.gte = new Date(query.desde);
      if (query.hasta) { const h = new Date(query.hasta); h.setHours(23, 59, 59, 999); where.createdAt.lte = h; }
    }
    const take = parseInt(query.limit ?? '50', 10);
    const skip = parseInt(query.offset ?? '0', 10);
    const [total, ordenes] = await repo.listOrdenesTrabajo({ where, take, skip });
    return { status: 200, body: { data: ordenes, total } };
  }

  // ─── OT: crear ───────────────────────────────────────────────────────────
  async function crearOrdenTrabajo(dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const { lineas, ...otData } = dto;
    if (!otData.fechaVencimientoSLA) {
      const horas = SLA_HORAS_POR_TIPO_OT[otData.tipoOT] ?? 48;
      otData.fechaVencimientoSLA = new Date(Date.now() + horas * 3600_000);
    }
    const orden = await prisma.$transaction(async (tx) => {
      const noOT = await nextNomenclatura(tx, 'OT');
      const ot = await repo.createOrdenTrabajoTx(tx, { ...otData, noOT });
      await repo.createLineasOTTx(tx, lineas.map(l => ({ ...l, ordenId: ot.id })));

      // Reservas: BOM-expansión + creación. Las reservas NO descuentan stock
      // aún — marcan el inventario comprometido. El stock disponible real se
      // calcula como stockActual - SUM(reservas activas).
      const expiraEn = new Date(Date.now() + OT_RESERVA_TTL_MS);
      const reservasACrear = [];
      for (const l of lineas) {
        const comps = await expandirLineaAComponentes(tx, l);
        for (const c of comps) {
          reservasACrear.push({
            productoId: c.productoId,
            cantidad:   c.cantidad,
            ordenId:    ot.id,
            expiraEn,
            motivo:     `OT ${noOT} · ${c.source}${c.nombre ? ' · ' + c.nombre : ''}`,
          });
        }
      }
      await repo.createReservasInventarioTx(tx, reservasACrear);
      return repo.findOrdenTrabajoFullById(tx, ot.id);
    });
    auditReq('ot:crear', _fakeReqForAudit(reqMeta, user), {
      ordenId: orden.id, tipoOT: orden.tipoOT, clienteId: orden.clienteId, reservas: orden.reservas?.length ?? 0,
    });
    return { status: 201, body: orden };
  }

  // ─── OT: eliminar (soft delete) ──────────────────────────────────────────
  async function eliminarOrdenTrabajo(id, user, reqMeta) {
    const ot = await repo.findOrdenTrabajoLightById(id);
    if (!ot || ot.deletedAt) throw new OtError(404, 'OT_NOT_FOUND', 'OT no encontrada.');
    if (ot.estaFacturada)    throw new OtError(409, 'OT_FACTURADA', 'No se puede eliminar una OT ya facturada.');
    await repo.softDeleteOrdenTrabajo(id);
    auditReq('ot:eliminar', _fakeReqForAudit(reqMeta, user), { otId: id });
    return { status: 204, body: null };
  }

  // ─── OT: cambiar estado (máquina + stock consume + ActivoCliente) ────────
  async function cambiarEstadoOT(id, dto, user, reqMeta, deps) {
    const { prisma } = deps;
    const ot = await repo.findOrdenTrabajoForEstadoChange(id);
    if (!ot) throw new OtError(404, 'OT_NOT_FOUND', 'OT no encontrada.');
    if (ot.estado === 'Cerrada' && ot.estaFacturada) {
      throw new OtError(423, 'OT_INMUTABLE', 'OT cerrada y facturada. Datos inmutables.');
    }
    // CRITICAL state-machine gate: rechaza Cancelada → Cerrada directo, etc.
    _validarTransicionOT(ot.estado, dto.estado);

    // Anti-fraude: cierre exige fotos suficientes si la OT lo configuró.
    if (dto.estado === 'Cerrada' && (ot.fotosRequeridas ?? 0) > 0) {
      const fotosCount = await repo.countFotosOrden(ot.id);
      if (fotosCount < ot.fotosRequeridas) {
        throw new OtError(422, 'FOTOS_INSUFICIENTES',
          `Faltan fotos: requieres ${ot.fotosRequeridas}, hay ${fotosCount}.`);
      }
    }

    const update = { estado: dto.estado };
    if (dto.fotosRequeridas   != null) update.fotosRequeridas   = dto.fotosRequeridas;
    if (dto.limpiezaRealizada != null) update.limpiezaRealizada = dto.limpiezaRealizada;
    if (dto.garantiaDias      != null) update.garantiaDias      = dto.garantiaDias;
    if (dto.estado === 'Cerrada')      update.completadaEn      = new Date();

    const resultado = await prisma.$transaction(async (tx) => {
      await repo.updateOrdenTrabajoEstadoTx(tx, id, update);

      let reservasLiberadas = 0;
      let stockDescontado  = 0;
      if (dto.estado === 'Cancelada') {
        const r = await repo.liberarReservasOTTx(tx, ot.id);
        reservasLiberadas = r.count;
      } else if (dto.estado === 'Cerrada') {
        // Consume cada reserva: atomic decrement + Kardex. Si stockActual <
        // cantidad reservada (drift), log AuditCaja y skip esa línea — el
        // cierre es el hecho real, las reservas son previsión.
        const reservas = await repo.findReservasOTActivasTx(tx, ot.id);
        for (const r of reservas) {
          const row = await repo.deducirStockAtomicoTx(tx, r.productoId, r.cantidad);
          if (!row) {
            console.warn(`[OT CIERRE] Stock drift productoId=${r.productoId} cantidad=${r.cantidad} OT=${ot.id}`);
            await repo.crearAuditCajaStockDriftTx(tx, {
              tipo:       'stock_drift_ot',
              empleadoId: user?.sub ?? null,
              detalle:    `Cierre OT ${ot.noOT ?? ot.id}: stock insuficiente productoId=${r.productoId} req=${r.cantidad}. Reserva consumida sin descontar.`,
            }).catch(() => {});
          } else {
            await repo.crearKardexSalidaTx(tx, r.productoId, r.cantidad);
            stockDescontado++;
          }
        }
        await repo.deleteAllReservasOTTx(tx, ot.id);
        reservasLiberadas = reservas.length;
      }

      // ActivoCliente auto-create on close (only for hardware OTs).
      if (dto.estado === 'Cerrada' && ['Instalacion', 'CCTV', 'Reparacion'].includes(ot.tipoOT)) {
        const garantia = dto.garantiaDias ?? ot.garantiaDias ?? 0;
        const fechaInst = new Date();
        const finGar = garantia > 0 ? new Date(fechaInst.getTime() + garantia * 86_400_000) : null;
        const productoLines = ot.lineas.filter(l => l.productoId);
        for (const l of productoLines) {
          await repo.crearActivoClienteTx(tx, {
            clienteId:        ot.clienteId,
            productoId:       l.productoId,
            ordenTrabajoId:   ot.id,
            cantidad:         l.cantidad,
            fechaInstalacion: fechaInst,
            finGarantia:      finGar,
          });
        }
      }
      return { reservasLiberadas, stockDescontado };
    });

    auditReq('ot:estado', _fakeReqForAudit(reqMeta, user), {
      otId: ot.id, estado: dto.estado,
      reservasLiberadas: resultado.reservasLiberadas,
      stockDescontado:   resultado.stockDescontado,
    });
    return { status: 200, body: { ok: true, ...resultado } };
  }

  // ─── OrdenInstalacion ────────────────────────────────────────────────────
  async function listarOrdenesInstalacion(query) {
    const where = {};
    if (query.estado) where.estado = query.estado;
    if (query.tipo)   where.tipo   = query.tipo;
    if (query.search) where.OR = [
      { servicio: { cliente: { razonSocial: { contains: query.search, mode: 'insensitive' } } } },
      { servicio: { plan:    { nombre:      { contains: query.search, mode: 'insensitive' } } } },
      { tecnico:  { nombre:  { contains: query.search, mode: 'insensitive' } } },
    ];
    const take    = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.page ?? '1', 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    const [ordenes, total] = await repo.listOrdenesInstalacion({ where, skip, take });
    return {
      status: 200,
      body: { data: ordenes, meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) } },
    };
  }

  async function crearOrdenInstalacion(dto, deps) {
    const { prisma } = deps;
    const { detalles, ...rest } = dto;
    const orden = await repo.createOrdenInstalacion({ ...rest, estado: 'Pendiente', detalles: { create: detalles } });
    if (rest.tipo === 'Instalacion') {
      await prisma.servicio.update({ where: { id: rest.servicioId }, data: { estado: 'EnInstalacion' } });
    }
    return { status: 201, body: orden };
  }

  async function actualizarOrdenInstalacion(id, dto, deps) {
    const { prisma } = deps;
    const { detalles, ...rest } = dto;
    try {
      const orden = await prisma.$transaction(async (tx) =>
        repo.updateOrdenInstalacionTx(tx, id, rest, { reemplazarDetalles: detalles !== undefined ? { detalles } : undefined }),
      );
      return { status: 200, body: orden };
    } catch (e) {
      if (e.code === 'P2025') throw new OtError(404, 'OI_NOT_FOUND', 'Orden no encontrada.');
      throw e;
    }
  }

  async function completarOrdenInstalacion(id, deps) {
    const { prisma } = deps;
    const orden = await repo.findOrdenInstalacionConDetalles(id);
    if (!orden) throw new OtError(404, 'OI_NOT_FOUND', 'Orden no encontrada.');
    if (orden.estado === 'Completada') throw new OtError(409, 'OI_YA_COMPLETADA', 'La orden ya está completada.');

    const tipoMovimiento     = orden.tipo === 'Retiro' ? 'Entrada' : 'Salida';
    const nuevoEstadoServicio = ESTADO_SERVICIO_POR_TIPO_OI[orden.tipo] ?? 'Activo';
    const stockInsuficiente   = [];

    if (tipoMovimiento === 'Salida' && orden.detalles.length > 0) {
      const ids = orden.detalles.map(d => d.productoId);
      const productos = await repo.findProductosForStock(ids);
      const stockMap  = Object.fromEntries(productos.map(p => [p.id, p]));
      for (const d of orden.detalles) {
        const p = stockMap[d.productoId];
        if (p && p.stockActual < d.cantidad) {
          stockInsuficiente.push({ nombre: p.nombre, stockActual: p.stockActual, requerido: d.cantidad });
        }
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      for (const d of orden.detalles) {
        const delta = tipoMovimiento === 'Salida' ? -d.cantidad : d.cantidad;
        await repo.ajustarStockTx(tx, d.productoId, delta);
        await repo.crearMovimientoOITx(tx, d.productoId, tipoMovimiento, d.cantidad, orden.id);
      }
      await repo.updateServicioEstadoTx(tx, orden.servicioId, nuevoEstadoServicio);
      return repo.updateOrdenInstalacionCompletadaTx(tx, id);
    });
    return { status: 200, body: { orden: result, alertasStock: stockInsuficiente } };
  }

  // ─── Servicios ───────────────────────────────────────────────────────────
  async function listarServicios(query) {
    const where = {};
    if (query.estado) where.estado = query.estado;
    if (query.clienteId) where.clienteId = query.clienteId;
    if (query.search) where.OR = [
      { cliente: { razonSocial: { contains: query.search, mode: 'insensitive' } } },
      { plan:    { nombre:      { contains: query.search, mode: 'insensitive' } } },
      { direccionInstalacion: { contains: query.search, mode: 'insensitive' } },
    ];
    const take = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 100);
    const pageNum = Math.max(parseInt(query.page ?? '1', 10) || 1, 1);
    const skip = (pageNum - 1) * take;
    const [servicios, total] = await repo.listServicios({ where, skip, take });
    return {
      status: 200,
      body: {
        data: servicios.map(_formatServicio),
        meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1) },
      },
    };
  }

  async function crearServicio(dto, deps) {
    const { prisma } = deps;
    const servicio = await prisma.$transaction(async (tx) => {
      const noServicio = await generarSiguienteCodigo('servicio', tx);
      return repo.createServicioTx(tx, { ...dto, noServicio });
    });
    return { status: 201, body: _formatServicio(servicio) };
  }

  async function actualizarServicio(id, dto) {
    try {
      const servicio = await repo.updateServicio(id, dto);
      return { status: 200, body: _formatServicio(servicio) };
    } catch (e) {
      if (e.code === 'P2025') throw new OtError(404, 'SVC_NOT_FOUND', 'Servicio no encontrado.');
      throw e;
    }
  }

  async function cambiarEstadoServicio(id, dto) {
    try {
      const actual = await repo.findServicioEstado(id);
      if (!actual) throw new OtError(404, 'SVC_NOT_FOUND', 'Servicio no encontrado.');
      _validarTransicionServicio(actual.estado, dto.estado);
      const servicio = await repo.updateServicioEstadoOnly(id, dto.estado);
      return { status: 200, body: _formatServicio(servicio) };
    } catch (e) {
      if (e instanceof OtError) throw e;
      if (e.code === 'P2025')   throw new OtError(404, 'SVC_NOT_FOUND', 'Servicio no encontrado.');
      throw e;
    }
  }

  // ─── Fotos ───────────────────────────────────────────────────────────────
  async function listarFotosOrden(id) {
    const fotos = await repo.listFotosOrden(id);
    return { status: 200, body: { data: fotos } };
  }

  /**
   * Upload de foto evidencia desde multipart. Pipeline:
   *   1. Verifica multipart Content-Type + req.file populated.
   *   2. Verifica OT existe + no inmutable.
   *   3. Valida MIME real por magic bytes (PNG/JPEG/WebP solamente, SVG
   *      rechazado por seguridad — anti XSS embebido en evidencia).
   *   4. sharp compress + strip EXIF (privacidad GPS doble: el frontend
   *      ya envía con watermark, el server normaliza y elimina metadata).
   *   5. Path en bucket: `${otId}/${ts}-${rand}.${ext}` — otId UUID seguro,
   *      randomBytes(4) seguro. NO hay input usuario en el path → cero
   *      path traversal.
   *   6. Upload Supabase + record OrdenFoto + audit ot:foto_upload_v2.
   */
  async function subirFotoUpload({ otId, file, latitudRaw, longitudRaw, descripcionRaw, headers }, user, reqMeta) {
    if (!supabase) throw new OtError(503, 'STORAGE_DISABLED', 'Storage no configurado.');
    const ct = String(headers?.['content-type'] ?? '');
    if (!ct.startsWith('multipart/form-data')) {
      throw new OtError(415, 'WRONG_CT', 'Content-Type debe ser multipart/form-data.');
    }
    if (!file) throw new OtError(400, 'NO_FILE', 'Archivo requerido (campo "file").');
    if (!file.buffer || file.buffer.length === 0) {
      throw new OtError(400, 'EMPTY_FILE', 'Archivo vacío.');
    }

    const ot = await repo.findOrdenForFotoCheck(otId);
    if (!ot) throw new OtError(404, 'OT_NOT_FOUND', 'OT no encontrada.');
    if (ot.estado === 'Cerrada' && ot.estaFacturada) {
      throw new OtError(423, 'OT_INMUTABLE', 'OT inmutable.');
    }

    const inputMime = detectMimeFromBuffer(file.buffer);
    if (!inputMime || !['image/png', 'image/jpeg', 'image/webp'].includes(inputMime)) {
      throw new OtError(415, 'INVALID_MIME', 'Solo PNG/JPG/WebP. SVG rechazado por seguridad.');
    }

    let buffer, finalMime, ext;
    try {
      const c = await comprimirImagen(file.buffer, inputMime);
      buffer = c.buffer; finalMime = c.mime; ext = c.ext;
    } catch (sharpErr) {
      console.error('[OT FOTO SHARP]', sharpErr?.message);
      throw new OtError(422, 'COMPRESS_FAIL', 'Imagen corrupta o ilegible.');
    }
    if (!buffer || buffer.length === 0) {
      throw new OtError(422, 'EMPTY_AFTER_COMPRESS', 'Imagen post-compresión vacía.');
    }

    // Path traversal-safe: ot.id es UUID de DB, randomBytes hex puro, ext desde
    // sharp output. Cero input usuario en el path.
    const filename = `${ot.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const { error: upErr } = await supabase.storage.from(OT_FOTOS_BUCKET).upload(filename, buffer, {
      contentType: finalMime, cacheControl: '604800', upsert: false,
    });
    if (upErr) {
      console.error('[OT FOTO UPLOAD]', upErr.message);
      throw new OtError(502, 'STORAGE_UPLOAD_FAIL', `Error al subir: ${upErr.message}`);
    }
    const { data: pub } = supabase.storage.from(OT_FOTOS_BUCKET).getPublicUrl(filename);

    const latitud  = latitudRaw  ? String(latitudRaw).slice(0, 30) : null;
    const longitud = longitudRaw ? String(longitudRaw).slice(0, 30) : null;
    const descripcion = descripcionRaw ? String(descripcionRaw).slice(0, 200) : null;

    const foto = await repo.createOrdenFoto({
      ordenId:   ot.id,
      url:       pub?.publicUrl ?? '',
      latitud, longitud, descripcion,
      subidoPor: user?.sub ?? null,
    });
    auditReq('ot:foto_upload_v2', _fakeReqForAudit(reqMeta, user), { ordenId: ot.id, fotoId: foto.id, gps: !!latitud });
    return { status: 201, body: foto };
  }

  async function registrarFotoUrl({ otId, data }, user, reqMeta) {
    const ot = await repo.findOrdenForFotoCheck(otId);
    if (!ot) throw new OtError(404, 'OT_NOT_FOUND', 'OT no encontrada.');
    if (ot.estado === 'Cerrada' && ot.estaFacturada) {
      throw new OtError(423, 'OT_INMUTABLE', 'OT inmutable.');
    }
    const foto = await repo.createOrdenFoto({
      ordenId:     ot.id,
      url:         data.url,
      latitud:     data.latitud  ?? null,
      longitud:    data.longitud ?? null,
      descripcion: data.descripcion ?? null,
      subidoPor:   user?.sub ?? null,
    });
    auditReq('ot:foto_upload', _fakeReqForAudit(reqMeta, user), { ordenId: ot.id, fotoId: foto.id, geo: !!data.latitud });
    return { status: 201, body: foto };
  }

  async function eliminarFoto({ ordenId, fotoId }, user, reqMeta) {
    const foto = await repo.findFotoConOrden(fotoId);
    if (!foto) throw new OtError(404, 'FOTO_NOT_FOUND', 'Foto no encontrada.');
    if (foto.orden.estado === 'Cerrada' && foto.orden.estaFacturada) {
      throw new OtError(423, 'OT_INMUTABLE', 'OT inmutable.');
    }
    await repo.deleteOrdenFoto(fotoId);
    auditReq('ot:foto_delete', _fakeReqForAudit(reqMeta, user), { ordenId, fotoId });
    return { status: 204, body: null };
  }

  return {
    OtError,
    // OT
    listarOrdenesTrabajo,
    crearOrdenTrabajo,
    eliminarOrdenTrabajo,
    cambiarEstadoOT,
    // OI
    listarOrdenesInstalacion,
    crearOrdenInstalacion,
    actualizarOrdenInstalacion,
    completarOrdenInstalacion,
    // Servicio
    listarServicios,
    crearServicio,
    actualizarServicio,
    cambiarEstadoServicio,
    // Fotos
    listarFotosOrden,
    subirFotoUpload,
    registrarFotoUrl,
    eliminarFoto,
  };
}

module.exports = createOrdenesService;
module.exports.OtError = OtError;
