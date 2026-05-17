/**
 * backend/modules/admin/ops/service.js
 *
 * Lógica de admin/ops. Cubre:
 *   - Mapa NOC (markers + totales) — ahora auth-gated (silent fix).
 *   - Incidencias reconciliación (list + resolver).
 *   - Track público con anti-brute-force in-memory + DB-persisted IpBlock.
 *   - Reset password / bloquear UsuarioPortal (nivel Propietario).
 *   - Verify público anti-tamper de facturas (HMAC + self-heal backfill).
 *   - Portal PDF v2 (cliente accede a sus propias facturas).
 *   - AuditCaja list + verificadores integridad hash-chain.
 *   - Meta endpoints introspection.
 *
 * Factory: createOpsService({ repo, auditReq, facturaVerifyHash,
 *   buildPdfData, renderPdfDoc, generarPdfDocumento, app })
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { _canonicalizarLog } = require('../../../shared/services/audit.service');

const TRACK_FAIL_WINDOW_MS = 5  * 60 * 1000;
const TRACK_FAIL_THRESHOLD = 5;
const TRACK_BLOCK_DURATION = 30 * 60 * 1000;

class OpsError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code   = code;
    if (extra) this.extra = extra;
  }
}

function _resolveAuditSecret() {
  return process.env.AUDIT_SECRET ?? process.env.JWT_SECRET ?? 'change-me-audit-secret';
}

function _canonicalizarCaja(row) {
  const safe = {
    tipo:       row.tipo ?? '',
    empleadoId: row.empleadoId ?? null,
    facturaId:  row.facturaId ?? null,
    monto:      row.monto != null ? String(row.monto) : null,
    descPct:    row.descPct != null ? String(row.descPct) : null,
    detalle:    row.detalle ?? '',
    ip:         row.ip ?? null,
    createdAt:  row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  };
  return JSON.stringify(safe, Object.keys(safe).sort());
}

function createOpsService(deps) {
  const { repo, auditReq, facturaVerifyHash, buildPdfData, renderPdfDoc, generarPdfDocumento, app, fmtPhone } = deps;
  if (!repo)                                          throw new Error('createOpsService: repo required');
  if (typeof auditReq !== 'function')                 throw new Error('createOpsService: auditReq required');
  if (typeof facturaVerifyHash !== 'function')        throw new Error('createOpsService: facturaVerifyHash required');

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

  // ─── Anti brute-force state (in-memory + DB-persisted hydration) ────────
  const failTally    = new Map();   // ip -> { count, firstFail }
  const activeBlocks = new Map();   // ip -> expiresAt(ms)

  async function hydrateIpBlocks() {
    try {
      const blocks = await repo.findActiveIpBlocks(new Date());
      for (const b of blocks) activeBlocks.set(b.ip, b.expiraEn.getTime());
      console.log(`[IpBlock] hydrated ${blocks.length} active block(s)`);
    } catch (e) { console.error('[IpBlock hydrate]', e.message); }
  }

  function isIpBlocked(ip) {
    const exp = activeBlocks.get(ip);
    if (!exp) return false;
    if (exp < Date.now()) { activeBlocks.delete(ip); return false; }
    return true;
  }

  async function _registerTrackFailure(ip, motivo) {
    const now = Date.now();
    const entry = failTally.get(ip);
    if (!entry || (now - entry.firstFail) > TRACK_FAIL_WINDOW_MS) {
      failTally.set(ip, { count: 1, firstFail: now });
      return false;
    }
    entry.count++;
    if (entry.count >= TRACK_FAIL_THRESHOLD) {
      failTally.delete(ip);
      const expiraEn = new Date(now + TRACK_BLOCK_DURATION);
      activeBlocks.set(ip, expiraEn.getTime());
      try {
        await repo.crearIpBlock({ ip, motivo, intentos: TRACK_FAIL_THRESHOLD, expiraEn });
        auditReq('security:ip_block', _fakeReqForAudit({ ip }), { ip, motivo, hasta: expiraEn });
      } catch (e) { console.error('[IpBlock persist]', e.message); }
      return true;
    }
    return false;
  }

  // ─── Mapa NOC ──────────────────────────────────────────────────────────
  /**
   * Cyber Neo silent fix: endpoint AHORA requiere auth (verificarJWT en
   * router) — antes era público y filtraba telefonos/razon social. Datos
   * geográficos siguen normalizados (NaN/0/0 filtrados). Phone formato
   * RD via fmtPhone para consistencia.
   */
  async function getMapaNoc() {
    const [clientes, suplidores, prospectos, nC, nS, nP] = await Promise.all([
      repo.findClientesGeo(),
      repo.findSuplidoresGeo(),
      repo.findProspectosGeo(),
      repo.countClientes(),
      repo.countSuplidores(),
      repo.countProspectos(),
    ]);
    const _fmt = typeof fmtPhone === 'function' ? fmtPhone : (v) => v;
    const toMarker = (list, tipo) => list.flatMap(r => {
      const lat = parseFloat(r.latitud);
      const lng = parseFloat(r.longitud);
      if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return [];
      return [{
        id:       r.id,
        tipo,
        nombre:   r.razonSocial ?? r.nombre,
        lat, lng,
        activo:   r.activo ?? null,
        estado:   r.estado ?? null,
        servicio: r.servicios?.[0]?.plan?.tipo ?? r.actividad ?? r.servicioInteresado,
        telefono: _fmt(r.telefonoPrincipal ?? r.telefono),
      }];
    });
    return {
      status: 200,
      body: {
        markers: [
          ...toMarker(clientes,   'cliente'),
          ...toMarker(suplidores, 'suplidor'),
          ...toMarker(prospectos, 'prospecto'),
        ],
        totales: { clientes: nC, suplidores: nS, prospectos: nP },
      },
    };
  }

  // ─── Incidencias ───────────────────────────────────────────────────────
  async function listIncidencias(query) {
    const where = {};
    if (query.tipo)      where.tipo      = query.tipo;
    if (query.severidad) where.severidad = query.severidad;
    if (query.resueltas === 'true')  where.resueltoEn = { not: null };
    if (query.resueltas === 'false') where.resueltoEn = null;
    const data = await repo.listIncidencias(where);
    return { status: 200, body: { data } };
  }

  async function resolverIncidencia(idRaw, dto, user, reqMeta) {
    const id = parseInt(idRaw, 10);
    if (!id || id < 1) throw new OpsError(400, 'BAD_ID', 'ID inválido.');
    try {
      const inc = await repo.resolverIncidencia(id, { resueltoEn: new Date(), resolucion: dto.resolucion, asignadoA: user.sub });
      auditReq('reconciliacion:resolver', _fakeReqForAudit(reqMeta, user), { incidenciaId: id });
      return { status: 200, body: inc };
    } catch (e) {
      if (e.code === 'P2025') throw new OpsError(404, 'NOT_FOUND', 'Incidencia no encontrada.');
      throw e;
    }
  }

  // ─── Track público ─────────────────────────────────────────────────────
  async function trackPin(pinRaw, ip) {
    if (isIpBlocked(ip)) {
      throw new OpsError(429, 'IP_BLOCKED', 'Demasiados intentos. IP bloqueada temporalmente.');
    }
    const pin = String(pinRaw || '').toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(pin)) {
      await _registerTrackFailure(ip, 'PIN formato inválido');
      throw new OpsError(400, 'PIN_INVALID', 'PIN inválido.');
    }
    const t = await repo.findTicketByPin(pin);
    if (!t) {
      await _registerTrackFailure(ip, 'PIN no encontrado');
      throw new OpsError(404, 'TICKET_NOT_FOUND', 'Ticket no encontrado.');
    }
    return { status: 200, body: t };
  }

  // ─── UsuarioPortal mgmt ────────────────────────────────────────────────
  async function resetPasswordUsuarioPortal(id, user, reqMeta, validUUID) {
    if (!validUUID(id)) throw new OpsError(400, 'BAD_ID', 'ID inválido.');
    // Password temporal random — formato 10+A1! para forzar fuerte aunque
    // randomBytes produzca solo lowercase.
    const nuevoPassword = crypto.randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + 'A1!';
    const hash = await bcrypt.hash(nuevoPassword, 12);
    try {
      const u = await repo.setUsuarioPortalPasswordHash(id, hash);
      auditReq('portal:password_reset_owner', _fakeReqForAudit(reqMeta, user), { usuarioId: u.id, email: u.email });
      return {
        status: 200,
        body: {
          usuario:          u,
          passwordTemporal: nuevoPassword,
          mensaje:          'Comparte este password con el cliente por canal seguro. Se mostrará una sola vez.',
        },
      };
    } catch (e) {
      if (e.code === 'P2025') throw new OpsError(404, 'NOT_FOUND', 'Usuario portal no encontrado.');
      throw e;
    }
  }

  async function bloquearUsuarioPortal(id, user, reqMeta, validUUID) {
    if (!validUUID(id)) throw new OpsError(400, 'BAD_ID', 'ID inválido.');
    try {
      const u = await repo.bloquearUsuarioPortal(id);
      auditReq('portal:bloquear_owner', _fakeReqForAudit(reqMeta, user), { usuarioId: u.id });
      return { status: 200, body: u };
    } catch (e) {
      if (e.code === 'P2025') throw new OpsError(404, 'NOT_FOUND', 'Usuario portal no encontrado.');
      throw e;
    }
  }

  // ─── Verify público anti-tamper ────────────────────────────────────────
  async function verifyFacturaPublico(hashRaw) {
    const hash = String(hashRaw || '').toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(hash)) throw new OpsError(400, 'HASH_INVALID', 'Hash inválido.', { valid: false });

    let match = await repo.findFacturaByVerifyHash(hash);
    if (!match) {
      // Fallback scan + self-heal backfill.
      const candidatos = await repo.listFacturasForVerifyFallback(hash);
      match = candidatos.find(f => facturaVerifyHash(f, 'verify-scan') === hash) ?? null;
      if (match) repo.backfillFacturaVerifyHash(match.id, hash).catch(() => {});
    }
    const empresa = await repo.findEmpresaIdentidad();
    if (!match) throw new OpsError(404, 'NOT_FOUND', 'Documento no encontrado o alterado.', { valid: false });

    const cliente = await repo.findClienteRazonSocial(match.clienteId).catch(() => null);
    return {
      status: 200,
      body: {
        valid:        true,
        tipo:         match.esCotizacion ? 'cotizacion' : 'factura',
        noFactura:    match.noFactura,
        ncf:          match.ncf,
        fechaEmision: match.fechaEmision,
        total:        Number(match.total),
        estado:       match.estado,
        cliente:      cliente?.razonSocial ?? null,
        empresa:      empresa ? { razonSocial: empresa.razonSocial, rnc: empresa.rnc } : null,
      },
    };
  }

  // ─── Portal PDF v2 ─────────────────────────────────────────────────────
  async function getPortalFacturaPdfV2(id, portalUser) {
    if (typeof buildPdfData !== 'function' || typeof renderPdfDoc !== 'function' || typeof generarPdfDocumento !== 'function') {
      throw new OpsError(503, 'PDF_DISABLED', 'PDF stack no disponible.');
    }
    const fact = await repo.findFacturaForPdfV2(id);
    if (!fact || fact.clienteId !== portalUser.clienteId) {
      throw new OpsError(404, 'NOT_FOUND', 'No encontrada.');
    }
    const data   = await buildPdfData(fact);
    const html   = renderPdfDoc({ tipo: fact.esCotizacion ? 'cotizacion' : 'factura', numero: fact.noFactura, ...data });
    const pdfBuf = await generarPdfDocumento(html);
    return {
      status: 200,
      stream: { contentType: 'application/pdf', disposition: `inline; filename="${fact.noFactura}.pdf"`, buffer: pdfBuf },
    };
  }

  // ─── AuditCaja list + verify ───────────────────────────────────────────
  async function listAuditCaja(query) {
    const where = {};
    if (query.tipo) where.tipo = query.tipo;
    const take = Math.min(parseInt(query.limit, 10) || 100, 500);
    const data = await repo.listAuditCaja({ where, take });
    return { status: 200, body: { data } };
  }

  async function verifyAuditCajaIntegrity(query) {
    const take = Math.min(parseInt(query.limit, 10) || 500, 5000);
    const rows = await repo.listAuditCajaForVerify(take);
    const secret = _resolveAuditSecret();
    let prev = 'GENESIS';
    let roto = null;
    for (const r of rows) {
      if (!r.hash) continue;
      const expected = crypto.createHmac('sha256', secret).update(_canonicalizarCaja(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex');
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break; }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }; break;
      }
      prev = r.hash;
    }
    return { status: 200, body: { ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto } };
  }

  async function verifyAuditLogIntegrity(query) {
    const take = Math.min(parseInt(query.limit, 10) || 500, 5000);
    const rows = await repo.listAuditLogForVerify(take);
    const secret = _resolveAuditSecret();
    let prev = 'GENESIS';
    let roto = null;
    for (const r of rows) {
      if (!r.hash) continue;
      const expected = crypto.createHmac('sha256', secret).update(_canonicalizarLog(r) + '|' + (r.prevHash ?? 'GENESIS')).digest('hex');
      if (expected !== r.hash) { roto = { id: r.id, esperado: expected, almacenado: r.hash }; break; }
      if (r.prevHash && r.prevHash !== 'GENESIS' && r.prevHash !== prev) {
        roto = { id: r.id, motivo: 'prevHash no coincide con la fila anterior', prev, prevHashAlmacenado: r.prevHash }; break;
      }
      prev = r.hash;
    }
    return { status: 200, body: { ok: !roto, verificadas: rows.length, integridad: roto ? 'ROTA' : 'OK', roto } };
  }

  // ─── Meta endpoints introspection ──────────────────────────────────────
  // MODULE_MAP es agrupación lógica para el dashboard de endpoints.
  const MODULE_MAP = [
    { test: /^\/api\/_meta/,                                    modulo: 'Sistema',         emoji: '⚙️' },
    { test: /^\/api\/health/,                                   modulo: 'Sistema',         emoji: '⚙️' },
    { test: /^\/api\/auth\//,                                   modulo: 'Autenticación',   emoji: '🔐' },
    { test: /^\/api\/incidencias/,                              modulo: 'Seguridad',       emoji: '🛡️' },
    { test: /^\/api\/credenciales/,                             modulo: 'Seguridad (Vault)', emoji: '🔑' },
    { test: /^\/api\/empleados/,                                modulo: 'RRHH',            emoji: '👥' },
    { test: /^\/api\/asistencia/,                               modulo: 'RRHH',            emoji: '👥' },
    { test: /^\/api\/roles/,                                    modulo: 'RRHH',            emoji: '👥' },
    { test: /^\/api\/clientes/,                                 modulo: 'CRM',             emoji: '🤝' },
    { test: /^\/api\/suplidores/,                               modulo: 'CRM',             emoji: '🤝' },
    { test: /^\/api\/prospectos/,                               modulo: 'CRM',             emoji: '🤝' },
    { test: /^\/api\/usuarios-portal/,                          modulo: 'CRM',             emoji: '🤝' },
    { test: /^\/api\/(productos|categorias|inventario|kardex)/, modulo: 'Inventario',      emoji: '📦' },
    { test: /^\/api\/prestamos/,                                modulo: 'Inventario',      emoji: '📦' },
    { test: /^\/api\/(items-catalogo|catalogo)/,                modulo: 'Ventas',          emoji: '💼' },
    { test: /^\/api\/(facturas|cotizaciones|cotizacion|ncf)/,   modulo: 'Ventas',          emoji: '💼' },
    { test: /^\/api\/ordenes/,                                  modulo: 'Ventas',          emoji: '💼' },
    { test: /^\/api\/(servicios|planes|plantillas)/,            modulo: 'Servicios',       emoji: '🛠️' },
    { test: /^\/api\/taller/,                                   modulo: 'Taller (RMA)',    emoji: '🔧' },
    { test: /^\/api\/track/,                                    modulo: 'Tracking Público',emoji: '📍' },
    { test: /^\/api\/activos-cliente/,                          modulo: 'CMDB',            emoji: '🗂️' },
    { test: /^\/api\/reportes/,                                 modulo: 'Reportes',        emoji: '📊' },
    { test: /^\/api\/dashboard/,                                modulo: 'Dashboard',       emoji: '📈' },
    { test: /^\/api\/mapa-noc/,                                 modulo: 'NOC / Mapa',      emoji: '🗺️' },
    { test: /^\/api\/portal\/(auth|sos|dashboard|cotizacion|catalogo|checkout|settings|facturas)/, modulo: 'Portal B2C', emoji: '🌐' },
    { test: /^\/api\/webhooks/,                                 modulo: 'Webhooks',        emoji: '🪝' },
    { test: /^\/api\/carrito/,                                  modulo: 'Ventas',          emoji: '💼' },
  ];

  function _resolveModule(path) {
    for (const m of MODULE_MAP) if (m.test.test(path)) return { modulo: m.modulo, emoji: m.emoji };
    return { modulo: 'Otros', emoji: '❓' };
  }

  let _routesCache = null;
  function _scanRoutes() {
    if (!app) return [];
    const out = [];
    const router = app.router ?? app._router;
    if (!router || !Array.isArray(router.stack)) return out;
    function walk(stack, basePath = '') {
      for (const layer of stack) {
        try {
          if (layer.route) {
            let pathStr = layer.route.path;
            if (Array.isArray(pathStr)) pathStr = pathStr[0];
            if (pathStr instanceof RegExp) pathStr = pathStr.toString();
            if (typeof pathStr !== 'string') pathStr = String(pathStr ?? '');
            const path = basePath + pathStr;
            const methodsObj = layer.route.methods || {};
            const methods = Object.keys(methodsObj).filter(m => methodsObj[m]);
            for (const m of methods) {
              const handlerNames = (layer.route.stack || []).map(s => s?.name).filter(Boolean);
              const auth =
                handlerNames.includes('verificarJWT')          ? 'JWT'        :
                handlerNames.includes('verificarPortalJWT')    ? 'PortalJWT'  :
                handlerNames.some(h => /Limiter$/.test(h))     ? 'rate-limit' :
                'public';
              const permiso = handlerNames.find(h => h.startsWith('requerirPermiso')) ? 'role-restricted' : null;
              const { modulo, emoji } = _resolveModule(path);
              out.push({ method: m.toUpperCase(), path, modulo, emoji, auth, permiso });
            }
          } else if (layer.name === 'router' && layer.handle?.stack) {
            walk(layer.handle.stack, basePath);
          }
        } catch (e) { console.error('[SCAN ROUTES] skip layer:', e.message); }
      }
    }
    walk(router.stack);
    return out;
  }

  function getMetaEndpoints(query) {
    if (!_routesCache || query.refresh === '1') {
      _routesCache = _scanRoutes()
        .filter(r => r.path.startsWith('/'))
        .sort((a, b) => a.modulo.localeCompare(b.modulo) || a.path.localeCompare(b.path));
    }
    const grouped = _routesCache.reduce((acc, r) => {
      const key = `${r.emoji} ${r.modulo}`;
      (acc[key] = acc[key] || []).push(r);
      return acc;
    }, {});
    return {
      status: 200,
      body: {
        total:      _routesCache.length,
        endpoints:  _routesCache,
        grouped,
        modulos:    Object.keys(grouped).sort(),
        generadoEn: new Date(),
      },
    };
  }

  return {
    OpsError,
    hydrateIpBlocks,
    getMapaNoc,
    listIncidencias, resolverIncidencia,
    trackPin,
    resetPasswordUsuarioPortal, bloquearUsuarioPortal,
    verifyFacturaPublico,
    getPortalFacturaPdfV2,
    listAuditCaja, verifyAuditCajaIntegrity, verifyAuditLogIntegrity,
    getMetaEndpoints,
  };
}

module.exports = createOpsService;
module.exports.OpsError = OpsError;
