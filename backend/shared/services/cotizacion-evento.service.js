/**
 * backend/shared/services/cotizacion-evento.service.js
 *
 * Mejora #4 — Hash-chain append-only para historial de Cotizaciones.
 *
 * Cada `appendEvento({ cotizacionId, accion, snapshot, user, reqMeta })`:
 *   1. Lee el último evento de la cotización (prevHash = ese.hash).
 *   2. Calcula hash = HMAC-SHA256(AUDIT_SECRET, canonical(snapshot) + prevHash).
 *   3. INSERT row con (hash, prevHash, snapshot, accion, ...).
 *
 * Verify chain: `verifyChain(cotizacionId)` recorre eventos ordered ASC y
 * recomputa cada hash, asegurando prevHash == hash anterior. Detecta:
 *   - Modificación de snapshot (hash no coincide al recomputar)
 *   - Borrado intermedio (prevHash de la siguiente ≠ hash anterior)
 *   - Reordenamiento (mismas pruebas)
 *
 * Cyber Neo:
 *   - AUDIT_SECRET en env (compartido con AuditCaja chain).
 *   - Canonical JSON: keys sorted + sin whitespace para hash determinista.
 *   - prevHash nullable solo en accion='crear' (primer evento). Cualquier
 *     otra accion con prevHash=null es señal de tampering.
 */

const crypto = require('crypto');

const ACCIONES_VALIDAS = ['crear', 'editar', 'enviar', 'aceptar', 'convertir', 'perder'];

function _canonical(obj) {
  // Stringify determinista: ordena keys recursivamente.
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

class CotizacionEventoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

function createCotizacionEventoService({ prisma }) {
  if (!prisma) throw new Error('createCotizacionEventoService: prisma required');

  // AUDIT_SECRET compartido con AuditCaja hash-chain. Si no está, fail-fast
  // EN runtime (no en factory init para no romper boot si solo se usa lectura).
  function _secret() {
    const s = process.env.AUDIT_SECRET ?? process.env.VAULT_KEY;
    if (!s || s.length < 32) {
      throw new CotizacionEventoError(503, 'AUDIT_SECRET_MISSING',
        'AUDIT_SECRET no configurado o muy corto (>=32 chars).');
    }
    return s;
  }

  async function _findLastHash(cotizacionId) {
    const last = await prisma.cotizacionEvento.findFirst({
      where:   { cotizacionId },
      orderBy: { createdAt: 'desc' },
      select:  { hash: true },
    });
    return last?.hash ?? null;
  }

  /**
   * Append-only. Idempotente NO (cada llamada agrega una fila). Llamar UNA
   * VEZ por mutación real de la cotización.
   *
   * @param {object} args
   * @param {string} args.cotizacionId       UUID de la Factura (esCotizacion=true)
   * @param {string} args.accion             'crear'|'editar'|'enviar'|'aceptar'|'convertir'|'perder'
   * @param {object} args.snapshot           Estado canónico al momento de la acción
   * @param {object} [args.user]             req.user (para empleadoId)
   * @param {object} [args.reqMeta]          { ip, ua }
   */
  async function appendEvento({ cotizacionId, accion, snapshot, user, reqMeta }) {
    if (typeof cotizacionId !== 'string' || cotizacionId.length < 8) {
      throw new CotizacionEventoError(400, 'BAD_COT_ID', 'cotizacionId inválido.');
    }
    if (!ACCIONES_VALIDAS.includes(accion)) {
      throw new CotizacionEventoError(400, 'BAD_ACCION',
        `Acción "${accion}" no es válida. Permitidas: ${ACCIONES_VALIDAS.join(', ')}.`);
    }
    const secret = _secret();
    const prevHash = await _findLastHash(cotizacionId);
    if (accion === 'crear' && prevHash !== null) {
      throw new CotizacionEventoError(409, 'CREAR_DUP',
        'Ya existe un evento "crear" para esta cotización.');
    }
    if (accion !== 'crear' && prevHash === null) {
      // Edge case: alguien apended sin haber creado primero. Lo permitimos
      // pero auditable — el verifyChain marcará "primer evento != crear".
    }
    const hash = _computeHash(secret, snapshot, prevHash);
    const ip = reqMeta?.ip ? String(reqMeta.ip).slice(0, 64) : null;
    const ua = reqMeta?.ua ? String(reqMeta.ua).slice(0, 200) : null;
    return prisma.cotizacionEvento.create({
      data: {
        cotizacionId,
        accion,
        snapshot,
        hash,
        prevHash,
        empleadoId: user?.sub ?? null,
        ip,
        ua,
      },
      select: { id: true, cotizacionId: true, accion: true, hash: true, prevHash: true, createdAt: true },
    });
  }

  /**
   * Lee y verifica la cadena completa. Devuelve:
   *   { valid: bool, eventos: [...], rupturas: [...] }
   * Cualquier ruptura indica tampering (DELETE manual, UPDATE de snapshot, etc.).
   */
  async function verifyChain(cotizacionId) {
    const secret = _secret();
    const eventos = await prisma.cotizacionEvento.findMany({
      where:   { cotizacionId },
      orderBy: { createdAt: 'asc' },
      include: { /* empleado lookup va al service caller si necesita */ },
    });
    const rupturas = [];
    let expectedPrev = null;
    for (const ev of eventos) {
      // Validar prevHash chain link
      if ((ev.prevHash ?? null) !== expectedPrev) {
        rupturas.push({
          eventoId: ev.id,
          tipo: 'PREVHASH_MISMATCH',
          esperado: expectedPrev,
          recibido: ev.prevHash ?? null,
        });
      }
      // Recalcular hash y comparar
      const recomputed = _computeHash(secret, ev.snapshot, ev.prevHash ?? null);
      if (recomputed !== ev.hash) {
        rupturas.push({
          eventoId: ev.id,
          tipo: 'HASH_MISMATCH',
          esperado: recomputed,
          recibido: ev.hash,
        });
      }
      expectedPrev = ev.hash;
    }
    // Primer evento debe ser 'crear' (mejor práctica, no obligatorio).
    if (eventos.length > 0 && eventos[0].accion !== 'crear') {
      rupturas.push({
        eventoId: eventos[0].id,
        tipo: 'PRIMER_EVENTO_NO_CREAR',
        accion: eventos[0].accion,
      });
    }
    return {
      valid:    rupturas.length === 0,
      total:    eventos.length,
      eventos:  eventos.map(e => ({
        id: e.id, accion: e.accion, hash: e.hash, prevHash: e.prevHash,
        empleadoId: e.empleadoId, ip: e.ip, createdAt: e.createdAt,
        // snapshot completo solo si valid; si hay rupturas, devolverlo permite
        // forense pero también marca claramente "no confiar en este dato".
        snapshot: e.snapshot,
      })),
      rupturas,
    };
  }

  // Helper para serializar Factura→snapshot canónico mínimo.
  function snapshotFromFactura(factura) {
    return {
      noFactura:    factura.noFactura,
      clienteId:    factura.clienteId,
      etapaPipeline: factura.etapaPipeline ?? null,
      estado:       factura.estado,
      subtotal:     Number(factura.subtotal ?? 0),
      itbis:        Number(factura.itbis ?? 0),
      total:        Number(factura.total ?? 0),
      fechaEmision: factura.fechaEmision ? new Date(factura.fechaEmision).toISOString() : null,
      fechaVence:   factura.fechaVence   ? new Date(factura.fechaVence).toISOString()   : null,
      lineasCount:  Array.isArray(factura.lineas) ? factura.lineas.length : null,
      // Hash de líneas para detectar cambios sin embarrar el snapshot
      lineasDigest: Array.isArray(factura.lineas) ? _shortDigest(factura.lineas) : null,
      condiciones:  factura.condiciones ?? null,
      notas:        factura.notas ?? null,
    };
  }

  function _shortDigest(arr) {
    return crypto.createHash('sha256')
      .update(_canonical(arr))
      .digest('hex').slice(0, 16);
  }

  return {
    CotizacionEventoError,
    ACCIONES_VALIDAS,
    appendEvento,
    verifyChain,
    snapshotFromFactura,
  };
}

module.exports = createCotizacionEventoService;
module.exports.CotizacionEventoError = CotizacionEventoError;
