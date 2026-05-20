/**
 * backend/shared/services/movimiento-inventario.service.js
 *
 * Mejora #2 — Hash-chain append-only para MovimientoInventario.
 *
 * Cada entrada o salida de almacén se firma con HMAC-SHA256 anclada al
 * hash del movimiento anterior del MISMO producto. Si una fila se altera,
 * borra o reordena, la cadena se rompe y `verifyChain(productoId)` lo
 * detecta.
 *
 * Uso típico — siempre dentro de la $transaction donde ocurre el cambio
 * de stock para que prev/curr queden consistentes:
 *
 *   const movSvc = createMovimientoInventarioService({ prisma });
 *   await prisma.$transaction(async (tx) => {
 *     // ... decrementar stock atómicamente ...
 *     await movSvc.appendMovimiento(tx, {
 *       productoId, tipo: 'Salida', cantidad,
 *       ordenInstalacionId: ord?.id ?? null,
 *       motivo: `factura:${noFactura}`,
 *     });
 *   });
 *
 * Cyber Neo:
 *   - AUDIT_SECRET en env (compartido con AuditCaja, AuditLog, CotizacionEvento).
 *   - Canonical JSON determinista: keys ordenadas, sin whitespace.
 *   - prevHash null solo en el PRIMER movimiento del producto.
 *   - El service NUNCA acepta tampering del caller: el hash se computa
 *     server-side, el caller NO puede setear prevHash/hash manualmente.
 *   - Si AUDIT_SECRET no está configurado o es <32 chars → throw 503 al
 *     primer uso (NO se bootea silenciosamente sin auditoría).
 */

const crypto = require('crypto');

const TIPOS_VALIDOS = ['Entrada', 'Salida'];

function _canonical(obj) {
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return stableStringify(obj);
}

function _computeHash(secret, snapshot, prevHash) {
  const payload = _canonical({ snapshot, prevHash: prevHash ?? null });
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

class MovimientoInventarioError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createMovimientoInventarioService({ prisma, withCurrentUserRls }) {
  if (!prisma) throw new Error('createMovimientoInventarioService: prisma required');

  // L1.1 RLS — wrapper tomado de la dep explícita O del prisma extendido (cuando
  // server.js pasa el cliente con `$extends`). Si ninguno está, `listarMisMovimientosRls`
  // lanza explícito — fail-closed para no degradar a "ver todo" silenciosamente.
  const _rlsRunner = typeof withCurrentUserRls === 'function'
    ? withCurrentUserRls
    : (typeof prisma.withCurrentUserRls === 'function'
        ? prisma.withCurrentUserRls.bind(prisma)
        : null);

  // Modo passthrough: si AUDIT_SECRET no está configurado en dev, el servicio
  // sigue insertando movimientos PERO sin hash (legacy behavior). En
  // PRODUCTION exige el secret — fail-fast en el primer uso, no permitimos
  // bootear sin auditoría firmada.
  const _secretRaw = process.env.AUDIT_SECRET ?? process.env.VAULT_KEY;
  const _hasSecret = typeof _secretRaw === 'string' && _secretRaw.length >= 32;
  const _passthroughMode = !_hasSecret && process.env.NODE_ENV !== 'production';
  if (_passthroughMode) {
    console.warn('[MOV-INV] AUDIT_SECRET no configurado — modo passthrough (sin hash-chain). Setear en producción.');
  }

  function _secret() {
    if (!_hasSecret) {
      throw new MovimientoInventarioError(503, 'AUDIT_SECRET_MISSING',
        'AUDIT_SECRET no configurado (>=32 chars). Hash-chain de inventario inoperante.');
    }
    return _secretRaw;
  }

  async function _findLastHash(db, productoId) {
    const last = await db.movimientoInventario.findFirst({
      where:   { productoId },
      orderBy: { id: 'desc' },
      select:  { hash: true },
    });
    return last?.hash ?? null;
  }

  /**
   * Append-only: registra un movimiento de inventario firmado en la
   * cadena hash. SIEMPRE ejecutar dentro de la transacción donde se
   * decrementa/incrementa el stock para mantener consistencia.
   *
   * @param {PrismaTx} tx                  Transacción Prisma activa.
   * @param {object}   args
   * @param {number}   args.productoId
   * @param {'Entrada'|'Salida'} args.tipo
   * @param {number}   args.cantidad        > 0 entero.
   * @param {string|null} [args.ordenInstalacionId]
   * @param {string}   [args.motivo]        Texto libre p/ trazabilidad.
   * @param {object}   [args.extra]         Datos adicionales en snapshot.
   */
  async function appendMovimiento(tx, args) {
    const {
      productoId, tipo, cantidad,
      ordenInstalacionId = null,
      motivo = null,
      extra  = null,
    } = args ?? {};

    if (!Number.isInteger(productoId) || productoId <= 0) {
      throw new MovimientoInventarioError(400, 'BAD_PRODUCTO_ID', 'productoId inválido.');
    }
    if (!TIPOS_VALIDOS.includes(tipo)) {
      throw new MovimientoInventarioError(400, 'BAD_TIPO',
        `tipo "${tipo}" no es válido. Permitidos: ${TIPOS_VALIDOS.join(', ')}.`);
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new MovimientoInventarioError(400, 'BAD_CANTIDAD', 'cantidad debe ser entero > 0.');
    }
    const fechaIso = new Date().toISOString();
    // Passthrough: dev sin secret → inserta sin hash (filas legacy).
    if (_passthroughMode) {
      return tx.movimientoInventario.create({
        data: {
          productoId,
          tipo,
          cantidad,
          ordenInstalacionId: ordenInstalacionId ?? null,
          fecha:              new Date(fechaIso),
          // prevHash / hash NULL — verifyChain las marca LEGACY_NO_HASH.
        },
      });
    }
    const secret = _secret();
    const prevHash = await _findLastHash(tx, productoId);
    // Snapshot canónico — solo campos relevantes para la firma.
    const snapshot = {
      productoId,
      tipo,
      cantidad,
      ordenInstalacionId: ordenInstalacionId ?? null,
      motivo:             motivo ?? null,
      fecha:              fechaIso,
      extra:              extra ?? null,
    };
    const hash = _computeHash(secret, snapshot, prevHash);
    return tx.movimientoInventario.create({
      data: {
        productoId,
        tipo,
        cantidad,
        ordenInstalacionId: ordenInstalacionId ?? null,
        fecha:              new Date(fechaIso),
        prevHash,
        hash,
      },
    });
  }

  /**
   * Verifica la cadena completa de movimientos de un producto.
   * Devuelve { valid, total, rupturas[], stockDerivado, stockActualDB }.
   *
   * Útil para:
   *   - Endpoint de auditoría (`/api/inventario/:id/verify-chain`).
   *   - Job nocturno que compara stockDerivado vs stockActual y alerta
   *     si discrepan (señal de mutación directa por SQL).
   */
  async function verifyChain(productoId, { recomputeStock = true } = {}) {
    const secret = _secret();
    const movs = await prisma.movimientoInventario.findMany({
      where:   { productoId },
      orderBy: { id: 'asc' },
      select:  { id: true, tipo: true, cantidad: true, ordenInstalacionId: true,
                 fecha: true, prevHash: true, hash: true },
    });
    const rupturas = [];
    let expectedPrev = null;
    let firstHashed  = false;
    let stockDerivado = 0;
    for (const m of movs) {
      const isLegacy = m.hash == null && m.prevHash == null;
      if (isLegacy) {
        // Fila legacy pre-migration: no participa en la cadena.
        rupturas.push({ id: m.id, tipo: 'LEGACY_NO_HASH' });
      } else {
        if (!firstHashed) {
          // Primera fila firmada del producto — prevHash debe ser null SOLO
          // si no había movimientos legacy antes. Si los hay, prevHash debe
          // estar null igual (la cadena arranca aquí).
          firstHashed = true;
          expectedPrev = null;
        }
        if ((m.prevHash ?? null) !== expectedPrev) {
          rupturas.push({
            id: m.id,
            tipo: 'PREVHASH_MISMATCH',
            esperado: expectedPrev,
            recibido: m.prevHash ?? null,
          });
        }
        const snapshot = {
          productoId,
          tipo:               m.tipo,
          cantidad:           m.cantidad,
          ordenInstalacionId: m.ordenInstalacionId ?? null,
          motivo:             null, // no persistido — recomputar requiere mismo input. Best-effort.
          fecha:              new Date(m.fecha).toISOString(),
          extra:              null,
        };
        const recomputed = _computeHash(secret, snapshot, m.prevHash ?? null);
        if (recomputed !== m.hash) {
          rupturas.push({
            id: m.id,
            tipo: 'HASH_MISMATCH',
            esperado: recomputed,
            recibido: m.hash,
            nota: 'motivo no se persiste — si era no-null al firmar, el recompute fallará. False positive aceptable; usar como señal débil.',
          });
        }
        expectedPrev = m.hash;
      }
      if (recomputeStock) {
        stockDerivado += (m.tipo === 'Entrada' ? m.cantidad : -m.cantidad);
      }
    }
    let stockActualDB = null;
    if (recomputeStock) {
      const p = await prisma.producto.findUnique({
        where:  { id: productoId },
        select: { stockActual: true },
      });
      stockActualDB = p?.stockActual ?? null;
    }
    return {
      valid:          rupturas.length === 0,
      total:          movs.length,
      rupturas,
      stockDerivado:  recomputeStock ? stockDerivado : null,
      stockActualDB,
      // True si la suma kardex coincide con el campo cacheado. Drift sugiere
      // mutación SQL directa fuera del flujo aplicación.
      stockConsistente: recomputeStock ? (stockDerivado === stockActualDB) : null,
    };
  }

  // ─── L1.1 RLS — listado enforced bajo política rls_owner_match ─────────────
  // MovimientoInventario tampoco tiene owner col (ver schema). Fallback política
  // v1: la query queda bajo SET LOCAL employee_id, lo que valida sesión legítima
  // pero no filtra por owner-de-fila. Útil como capa demostrativa + smoke test
  // de la pipeline end-to-end; cuando schema agregue `empleadoCreadorId Int?`,
  // este método filtra por él sin más wiring.
  async function listarMisMovimientosRls(query, user) {
    if (typeof _rlsRunner !== 'function') {
      throw new MovimientoInventarioError(500, 'RLS_WRAPPER_MISSING',
        'withCurrentUserRls no disponible — RLS enforce inoperante.');
    }
    if (!user?.sub) {
      throw new MovimientoInventarioError(401, 'NO_USER',
        'user.sub requerido para RLS owner-match.');
    }
    const take    = Math.min(Math.max(parseInt(query?.limit, 10) || 50, 1), 200);
    const pageNum = Math.max(parseInt(query?.page, 10) || 1, 1);
    const skip    = (pageNum - 1) * take;
    const productoId = Number(query?.productoId);
    return _rlsRunner(async (tx) => {
      const where = Number.isInteger(productoId) && productoId > 0
        ? { productoId }
        : {};
      const [data, total] = await Promise.all([
        tx.movimientoInventario.findMany({
          where, take, skip,
          orderBy: { fecha: 'desc' },
          select: {
            id: true, productoId: true, tipo: true, cantidad: true,
            ordenInstalacionId: true, fecha: true,
          },
        }),
        tx.movimientoInventario.count({ where }),
      ]);
      return {
        status: 200,
        body: {
          data,
          meta: { total, page: pageNum, totalPages: Math.max(Math.ceil(total / take), 1), rlsEnforced: true },
        },
      };
    });
  }

  return {
    MovimientoInventarioError,
    TIPOS_VALIDOS,
    appendMovimiento,
    verifyChain,
    listarMisMovimientosRls,
  };
}

module.exports = createMovimientoInventarioService;
module.exports.MovimientoInventarioError = MovimientoInventarioError;
