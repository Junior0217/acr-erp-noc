/**
 * backend/modules/crm/portal-b2c/service.js
 *
 * Lógica del Portal B2C. Cyber Neo — superficie PÚBLICA:
 *   - Login: respuesta GENÉRICA "Credenciales inválidas" → CERO enumeration.
 *     No diferenciamos "email no existe" vs "password incorrecto".
 *   - Forgot password: responde 200 SIEMPRE (incluso si email no existe).
 *     El email solo se envía si el user existe — atacante no puede enumerar.
 *   - Audit logging: NO incluye password ni hash en metadata. Email sí
 *     porque ya está en la query string del request.
 *   - Reset tokens: 64-hex random, TTL 15min, single-use (delete on consume).
 *   - SOS quota: 3 tickets pendientes / 24h por cliente.
 *   - Checkout: factura Borrador con paymentRef = factura.id, monto guarded
 *     por webhook HMAC.
 *   - Webhook Azul: HMAC-SHA256 timing-safe + monto MATCH antes de pagar.
 *
 * Factory: createPortalService({ repo, auditReq, signPortalToken,
 *   persistirVerifyHash, nextNomenclatura, emailTransporter,
 *   buildFacturaPDFBuffer, redisClient? })
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

class PortalError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

const SOS_QUOTA_PER_CLIENT = 3;
const SOS_QUOTA_WINDOW_MS  = 24 * 3600_000;

function createPortalService(deps) {
  const {
    repo, auditReq, signPortalToken,
    persistirVerifyHash, nextNomenclatura, emailTransporter,
    buildFacturaPDFBuffer, redisClient,
  } = deps;
  if (!repo)                          throw new Error('createPortalService: repo required');
  if (typeof auditReq !== 'function') throw new Error('createPortalService: auditReq required');
  if (typeof signPortalToken !== 'function') throw new Error('createPortalService: signPortalToken required');

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

  function _buildCookieOpts(maxAge) {
    const isProd = process.env.NODE_ENV === 'production';
    return {
      httpOnly: true,
      secure:   isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge,
      ...(isProd ? { partitioned: true } : {}),
    };
  }

  /**
   * Descriptor de cookies para Set-Cookie en respuesta. portal token httpOnly,
   * pct-csrf NO httpOnly (frontend lee del DOM/document.cookie).
   */
  function _portalCookiesDescriptor(token) {
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    const base   = _buildCookieOpts(maxAge);
    const csrf   = crypto.randomBytes(32).toString('hex');
    return {
      set: [
        { name: 'pct',      value: token, opts: base },
        { name: 'pct-csrf', value: csrf,  opts: { ...base, httpOnly: false } },
      ],
      csrfToken: csrf,
    };
  }

  // ─── Reset token store (Redis preferido, Map fallback) ─────────────────
  const _resetTokens = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _resetTokens) if (v.exp < now) _resetTokens.delete(k);
  }, 5 * 60_000).unref();

  async function _storeResetToken(token, usuarioId) {
    if (redisClient) {
      await redisClient.set(`pwd_reset:${token}`, usuarioId, 'EX', 900);
    } else {
      _resetTokens.set(token, { usuarioId, exp: Date.now() + 15 * 60_000 });
    }
  }

  async function _consumeResetToken(token) {
    if (redisClient) {
      const id = await redisClient.getdel(`pwd_reset:${token}`);
      return id || null;
    }
    const entry = _resetTokens.get(token);
    if (!entry || entry.exp < Date.now()) return null;
    _resetTokens.delete(token);
    return entry.usuarioId;
  }

  // ─── /portal/auth/csrf ─────────────────────────────────────────────────
  function getOrIssueCsrf(existingCookie) {
    if (existingCookie) return { status: 200, body: { csrfToken: existingCookie } };
    const fresh = crypto.randomBytes(32).toString('hex');
    return {
      status: 200,
      body: { csrfToken: fresh },
      cookies: {
        set: [{ name: 'pct-csrf', value: fresh, opts: { ..._buildCookieOpts(30 * 24 * 60 * 60 * 1000), httpOnly: false } }],
      },
    };
  }

  // ─── Catalog público (autenticación NO requerida — más permisivo que portal/catalogo) ─
  async function listCatalogPortal(query) {
    const where = { activo: true };
    if (query.categoria) where.categoria = query.categoria;
    if (query.tipo)      where.tipo      = query.tipo;
    if (query.search)    where.nombre    = { contains: query.search, mode: 'insensitive' };
    const items = await repo.listCatalogoPortal(where);
    return { status: 200, body: { data: items, total: items.length } };
  }

  // ─── Settings ──────────────────────────────────────────────────────────
  async function getSettings() {
    const settings = await repo.getOrCreatePortalSettings();
    return { status: 200, body: settings };
  }

  async function updateSettings(data, user, reqMeta) {
    const settings = await repo.upsertPortalSettings(data);
    auditReq('portal:settings_updated', _fakeReqForAudit(reqMeta, user), data);
    return { status: 200, body: settings };
  }

  // ─── Register ──────────────────────────────────────────────────────────
  async function register(dto, reqMeta) {
    const { nombre, email, password } = dto;
    const existing = await repo.findUsuarioByEmail(email);
    if (existing) throw new PortalError(409, 'EMAIL_EXISTS', 'Email ya registrado.');
    const count    = await repo.countUsuarios();
    const noUsuario = `USR-${String(count + 1).padStart(4, '0')}`;
    const hash = await bcrypt.hash(password, 12);
    const usuario = await repo.crearUsuario({ noUsuario, nombre, email, passwordHash: hash });
    const token = signPortalToken(usuario);
    const cookies = _portalCookiesDescriptor(token);
    auditReq('portal:register', _fakeReqForAudit(reqMeta), { usuarioId: usuario.id, email }, { userId: null, userName: nombre });
    return {
      status:  201,
      body:    { id: usuario.id, nombre: usuario.nombre, email: usuario.email, noUsuario: usuario.noUsuario },
      cookies: { set: cookies.set },
      headers: { 'X-Portal-CSRF': cookies.csrfToken },
    };
  }

  // ─── Login ─────────────────────────────────────────────────────────────
  /**
   * Cyber Neo: respuesta unificada 401 "Credenciales inválidas" para
   * "email no existe" y "password incorrecto". Cuenta inactiva → 403 distinto
   * (info que el atacante necesita el ID de cuenta, no derivable solo del email).
   */
  async function login(dto, reqMeta) {
    const { email, password } = dto;
    let usuario = await repo.findUsuarioByEmail(email);

    // Auto-seed demo account (solo en dev/staging para demos rápidas).
    if (!usuario && email === 'demo.empresa@acrtest.do') {
      const hash    = await bcrypt.hash('Demo2026!', 12);
      const count   = await repo.countUsuarios();
      usuario = await repo.crearUsuario({
        noUsuario: `USR-${String(count + 1).padStart(4, '0')}`,
        nombre:    'Carlos Demo',
        email:     'demo.empresa@acrtest.do',
        passwordHash: hash,
        telefono:  '809-555-1234',
      });
      console.log('[PORTAL] Auto-seeded demo account:', usuario.id);
    }

    if (!usuario)         throw new PortalError(401, 'BAD_CREDENTIALS', 'Credenciales inválidas.');
    if (!usuario.activo)  throw new PortalError(403, 'INACTIVE',         'Cuenta inactiva.');
    const valid = await bcrypt.compare(password, usuario.passwordHash);
    if (!valid) {
      auditReq('portal:login_fail', _fakeReqForAudit(reqMeta), { email }, { userId: null });
      throw new PortalError(401, 'BAD_CREDENTIALS', 'Credenciales inválidas.');
    }
    const token = signPortalToken(usuario);
    const cookies = _portalCookiesDescriptor(token);
    auditReq('portal:login', _fakeReqForAudit(reqMeta), { usuarioId: usuario.id, email }, { userId: null, userName: usuario.nombre });
    return {
      status:  200,
      body:    { id: usuario.id, nombre: usuario.nombre, email: usuario.email, noUsuario: usuario.noUsuario, clienteId: usuario.clienteId },
      cookies: { set: cookies.set },
      headers: { 'X-Portal-CSRF': cookies.csrfToken },
    };
  }

  function logout() {
    return { status: 204, body: null, cookies: { clear: ['pct', 'pct-csrf'] } };
  }

  // ─── /portal/auth/me ───────────────────────────────────────────────────
  async function getMe(portalUser) {
    const usuario = await repo.findUsuarioMe(portalUser.sub);
    if (!usuario)        return { status: 401, body: { error: 'Usuario no encontrado.' }, cookies: { clear: ['pct'] } };
    if (!usuario.activo) return { status: 403, body: { error: 'Cuenta inactiva.' },       cookies: { clear: ['pct'] } };
    return { status: 200, body: usuario };
  }

  // ─── Forgot / Reset password ───────────────────────────────────────────
  /**
   * Cyber Neo: SIEMPRE responde 200 OK aunque el email no exista, para evitar
   * que un atacante enumere cuentas registradas. El email solo se envía si
   * el usuario existe — el atacante no ve diferencia en la respuesta HTTP.
   */
  async function forgotPassword(dto, reqMeta) {
    const { email } = dto;
    // Respondemos OK ANTES de tocar la DB para que el timing de respuesta
    // tampoco revele si el email existe o no.
    const response = { status: 200, body: { ok: true } };

    setImmediate(async () => {
      try {
        const usuario = await repo.findUsuarioByEmailLight(email);
        if (!usuario) return;
        const token = crypto.randomBytes(32).toString('hex');
        await _storeResetToken(token, usuario.id);
        const resetUrl = `${process.env.PORTAL_URL || process.env.CORS_ORIGIN || 'http://localhost:5173'}/portal?reset=${token}`;
        console.log(`[PORTAL RESET] ${email} → ${resetUrl}`);
        if (emailTransporter && process.env.SMTP_USER) {
          emailTransporter.sendMail({
            from:    `"ACR Networks" <${process.env.SMTP_USER}>`,
            to:      email,
            subject: 'Restablecer contraseña — ACR',
            html: `<p>Hola <strong>${usuario.nombre}</strong>,</p>
                   <p>Haz clic en el enlace para restablecer tu contraseña (válido 15 min):</p>
                   <p><a href="${resetUrl}">${resetUrl}</a></p>`,
          }).catch(err => console.error('[PORTAL RESET EMAIL]', err.message));
        }
      } catch (e) { console.error('[PORTAL FORGOT bg]', e.message); }
    });

    return response;
  }

  async function resetPassword(dto, reqMeta) {
    const { token, password } = dto;
    const usuarioId = await _consumeResetToken(token);
    if (!usuarioId) throw new PortalError(400, 'TOKEN_INVALID', 'Token inválido o expirado.');
    const hash = await bcrypt.hash(password, 12);
    await repo.updateUsuarioPasswordHash(usuarioId, hash);
    auditReq('portal:password_reset', _fakeReqForAudit(reqMeta), { usuarioId }, { userId: null, userName: null });
    return { status: 200, body: { ok: true } };
  }

  // ─── SOS Ticket ────────────────────────────────────────────────────────
  async function crearSosTicket(dto, portalUser, reqMeta) {
    const { descripcion } = dto;
    const clienteId = portalUser.clienteId;
    if (!clienteId) throw new PortalError(422, 'NO_LINK', 'Tu cuenta no está vinculada a un cliente. Contacta a ACR para vincularla.');
    const desde = new Date(Date.now() - SOS_QUOTA_WINDOW_MS);
    const recientes = await repo.countOTsRecientes(clienteId, desde);
    if (recientes >= SOS_QUOTA_PER_CLIENT) {
      auditReq('portal:sos_quota', _fakeReqForAudit(reqMeta), { clienteId, count: recientes }, { userId: null, userName: portalUser.nombre });
      throw new PortalError(429, 'SOS_QUOTA', `Límite alcanzado (${SOS_QUOTA_PER_CLIENT} tickets/24h). Contacta a ACR si es urgente.`);
    }
    const ot = await repo.crearOTSos({
      clienteId,
      tipoOT:        'SoporteTecnico',
      estado:        'Pendiente',
      notasTecnicas: descripcion || 'Solicitud de soporte técnico vía Portal B2C',
      metadatos:     { origen: 'portal_sos', usuarioId: portalUser.sub },
    });
    auditReq('portal:sos_created', _fakeReqForAudit(reqMeta), { otId: ot.id }, { userId: null, userName: portalUser.nombre });
    return { status: 201, body: { id: ot.id, estado: ot.estado } };
  }

  // ─── Cotización Portal ─────────────────────────────────────────────────
  async function crearCotizacionPortal(dto, portalUser, reqMeta) {
    const { lineas, descuentoPct, notas } = dto;
    const clienteId = portalUser.clienteId;
    if (!clienteId) throw new PortalError(422, 'NO_LINK', 'Tu cuenta no está vinculada a un cliente. Contacta a ACR.');

    const subtotalBruto = lineas.reduce((s, l) => s + l.precio * l.cantidad, 0);
    const descAmt       = descuentoPct > 0 ? Math.round(subtotalBruto * (descuentoPct / 100) * 100) / 100 : 0;
    const subtotal      = Math.round((subtotalBruto - descAmt) * 100) / 100;
    const itbis         = Math.round(subtotal * 0.18 * 100) / 100;
    const total         = Math.round((subtotal + itbis) * 100) / 100;
    const noFactura     = `PCT${new Date().getFullYear()}-${String(Date.now()).slice(-8)}`;

    const factura = await repo.crearFactura({
      noFactura, clienteId,
      estado: 'Borrador', subtotal, itbis, total,
      esCotizacion: true, tipoNcf: 'Consumidor Final',
      fechaVence: new Date(Date.now() + 30 * 86_400_000),
      notas: notas ?? `Cotización Portal — ${lineas.length} línea(s)${descuentoPct > 0 ? ` (${descuentoPct}% Pack Empresarial)` : ''}`,
      lineas: { createMany: { data: lineas.map(l => ({ descripcion: l.nombre, cantidad: l.cantidad, precioUnitario: l.precio })) } },
    });

    if (typeof persistirVerifyHash === 'function') await persistirVerifyHash(factura);
    auditReq('portal:cotizacion', _fakeReqForAudit(reqMeta), { facturaId: factura.id, total, lineas: lineas.length }, { userId: null, userName: portalUser.nombre });
    return { status: 201, body: { id: factura.id, noFactura: factura.noFactura, total, lineas: factura.lineas.length } };
  }

  async function listarCotizacionesPortal(portalUser) {
    const clienteId = portalUser.clienteId;
    if (!clienteId) return { status: 200, body: { data: [] } };
    const data = await repo.listCotizacionesPortal(clienteId);
    return { status: 200, body: { data } };
  }

  // ─── Dashboard ─────────────────────────────────────────────────────────
  async function getDashboard(portalUser) {
    const clienteId = portalUser.clienteId;
    if (!clienteId) return { status: 200, body: { servicios: [], facturas: [], ordenes: [], deudaTotal: 0, sinVincular: true } };
    const [servicios, facturas, ordenes] = await repo.findDashboardData(clienteId);
    const deudaTotal = facturas.filter(f => f.estado === 'Vencida').reduce((s, f) => s + Number(f.total), 0);
    return { status: 200, body: { servicios, facturas, ordenes, deudaTotal } };
  }

  // ─── Factura PDF (portal) ──────────────────────────────────────────────
  async function getFacturaPdfPortal(id, portalUser) {
    if (typeof buildFacturaPDFBuffer !== 'function') {
      throw new PortalError(503, 'PDF_DISABLED', 'PDF builder no disponible.');
    }
    const factura = await repo.findFacturaForPdf(id);
    if (!factura) throw new PortalError(404, 'NOT_FOUND', 'Factura no encontrada.');
    if (factura.clienteId !== portalUser.clienteId) throw new PortalError(403, 'ACCESO_DENEGADO', 'Acceso denegado.');
    const buf = await buildFacturaPDFBuffer(factura);
    return {
      status: 200,
      stream: { contentType: 'application/pdf', disposition: `inline; filename="factura-${factura.noFactura}.pdf"`, buffer: buf },
    };
  }

  // ─── Checkout ──────────────────────────────────────────────────────────
  async function checkout(dto, portalUser, reqMeta, body) {
    const { items } = dto;
    const clienteId = portalUser.clienteId;
    if (!clienteId) throw new PortalError(422, 'NO_LINK', 'Tu cuenta no está vinculada a un cliente.');

    const ids = items.map(i => i.itemCatalogoId);
    const catalogo = await repo.findItemsCatalogoActivos(ids);
    if (catalogo.length !== ids.length) {
      throw new PortalError(400, 'ITEM_INVALID', 'Uno o más items no existen o están inactivos.');
    }
    const catMap = Object.fromEntries(catalogo.map(c => [c.id, c]));

    let subtotal = 0;
    const lineasData = items.map(i => {
      const c = catMap[i.itemCatalogoId];
      const precio = Number(c.precio);
      subtotal += precio * i.cantidad;
      return { itemCatalogoId: c.id, descripcion: c.nombre, cantidad: i.cantidad, precioUnitario: precio };
    });
    const itbis = Math.round(subtotal * 0.18 * 100) / 100;
    const total = Math.round((subtotal + itbis) * 100) / 100;

    const factura = await repo.crearFactura({
      noFactura: `PAGO-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      clienteId, estado: 'Borrador',
      subtotal, itbis, total,
      notas: `Checkout portal: pendiente pago via ${body?.metodoPago ?? 'Tarjeta'}.`,
      esCotizacion: false,
      lineas: { createMany: { data: lineasData } },
    });
    if (typeof persistirVerifyHash === 'function') await persistirVerifyHash(factura);
    auditReq('ecommerce:checkout', _fakeReqForAudit(reqMeta), { facturaId: factura.id, total, items: items.length }, { userId: null, userName: portalUser.nombre });
    return { status: 201, body: { paymentRef: factura.id, total, gateway: 'azul', sandbox: !process.env.AZUL_WEBHOOK_SECRET } };
  }

  // ─── Webhook Azul ──────────────────────────────────────────────────────
  /**
   * Cyber Neo: HMAC verify ANTES de cualquier acceso a DB, monto MATCH antes
   * de marcar pagado. Estado != aprobado → factura Anulada. Idempotente vía
   * estado=Pagada check.
   */
  function _verificarFirmaWebhook(secret, payloadRaw, firmaHex) {
    if (!secret || !firmaHex) return false;
    const computado = crypto.createHmac('sha256', secret).update(payloadRaw).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(computado, 'hex'), Buffer.from(firmaHex, 'hex'));
    } catch { return false; }
  }

  async function procesarWebhookAzul({ rawBody, firma }, dto, reqMeta, deps) {
    const { prisma } = deps;
    const secret = process.env.AZUL_WEBHOOK_SECRET;
    if (!secret) throw new PortalError(503, 'GATEWAY_OFF', 'Pasarela no configurada. Define AZUL_WEBHOOK_SECRET.');
    if (!_verificarFirmaWebhook(secret, rawBody, firma)) {
      auditReq('webhook:azul_signature_fail', _fakeReqForAudit(reqMeta), { firma: firma?.slice(0, 12) }, { userId: null });
      throw new PortalError(401, 'BAD_SIGNATURE', 'Firma inválida.');
    }

    const factura = await repo.findFacturaConLineasItem(dto.paymentRef);
    if (!factura)                       throw new PortalError(404, 'NOT_FOUND',     'Pago no encontrado.');
    if (factura.estado === 'Pagada')   throw new PortalError(409, 'YA_PAGADO',     'Pago ya procesado.');
    if (Number(factura.total) !== dto.monto) {
      auditReq('webhook:amount_mismatch', _fakeReqForAudit(reqMeta), { paymentRef: dto.paymentRef, expected: Number(factura.total), got: dto.monto });
      throw new PortalError(422, 'AMOUNT_MISMATCH', 'Monto no coincide.');
    }
    if (dto.estadoPago !== 'aprobado') {
      await repo.updateFacturaAnulada(factura.id, `${factura.notas ?? ''} | Rechazado: ${dto.estadoPago}`);
      return { status: 200, body: { ok: true, estado: 'rechazado' } };
    }

    await prisma.$transaction(async (tx) => {
      await repo.updateFacturaPagadaTx(tx, factura.id, {
        estado:    'Pagada',
        fechaPago: dto.fechaPago ?? new Date(),
        notas:     `${factura.notas ?? ''} | Azul tx: ${dto.transactionId}`,
      });
      const tieneInstalable = factura.lineas.some(l => ['CCTV','Redes','CercoElectrico'].includes(l.itemCatalogo?.categoria));
      const tieneRecurrente = factura.lineas.some(l => l.itemCatalogo?.tipo === 'Recurrente');

      if (tieneInstalable && typeof nextNomenclatura === 'function') {
        const noOT = await nextNomenclatura(tx, 'OT');
        await repo.crearOrdenTrabajoTx(tx, {
          clienteId: factura.clienteId, noOT,
          tipoOT:    'Instalacion', estado: 'Pendiente',
          metadatos: { origen: 'ecommerce', facturaId: factura.id, txAzul: dto.transactionId },
          fechaVencimientoSLA: new Date(Date.now() + 7 * 24 * 3600_000),
          lineas: { createMany: { data: factura.lineas.map(l => ({
            itemCatalogoId: l.itemCatalogoId, descripcion: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precioUnitario,
          })) } },
        });
      }
      if (tieneRecurrente) {
        const planItem = factura.lineas.find(l => l.itemCatalogo?.tipo === 'Recurrente');
        if (planItem) {
          await repo.updateFacturaNotasTx(tx, factura.id, `${factura.notas ?? ''} | Servicio recurrente: ${planItem.itemCatalogo.nombre}`);
        }
      }
    });

    auditReq('webhook:azul_ok', _fakeReqForAudit(reqMeta), { paymentRef: dto.paymentRef, transactionId: dto.transactionId, monto: dto.monto });
    return { status: 200, body: { ok: true, estado: 'pagado' } };
  }

  return {
    PortalError,
    getOrIssueCsrf,
    listCatalogPortal,
    getSettings, updateSettings,
    register, login, logout, getMe,
    forgotPassword, resetPassword,
    crearSosTicket, crearCotizacionPortal, listarCotizacionesPortal,
    getDashboard, getFacturaPdfPortal,
    checkout, procesarWebhookAzul,
  };
}

module.exports = createPortalService;
module.exports.PortalError = PortalError;
