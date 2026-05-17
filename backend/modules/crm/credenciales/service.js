/**
 * backend/modules/crm/credenciales/service.js
 *
 * Vault PAM service. CRÍTICO Cyber Neo — superficie de máxima sensibilidad:
 *
 *   1. AES-256-GCM con VAULT_KEY (base64) — NUNCA JWT_SECRET. Si VAULT_KEY
 *      no está seteado, todo el módulo responde 503 (vault disabled).
 *   2. IV random 12 bytes por encrypt (nonce único — requisito GCM).
 *   3. authTag separado de ciphertext, almacenado concatenado (last 16 bytes).
 *   4. Listado NUNCA devuelve passwordEnc/passwordIv. Solo metadata.
 *   5. Reveal exige: permiso vault:reveal + TOTP estricto (header X-TOTP) +
 *      cooldown 30s/usuario (shared con middleware via vaultLastReveal Map).
 *   6. Bulk detect: > 5 reveals/hora del mismo user → IncidenciaReconciliacion
 *      severidad CRITICA + audit vault:bulk_reveal_alert.
 *   7. console.log NUNCA imprime password plano. err.message en catch sí
 *      puede leakearlo si crypto throw — wrap con genérico.
 *   8. Audit trail: vault:crear, vault:reveal, vault:eliminar — con
 *      credencialId + clienteId + tipo (cero password en metadata).
 *
 * Factory: createCredencialesService({ repo, auditReq, vaultLastReveal })
 */

const crypto = require('crypto');

class VaultError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code   = code;
  }
}

// ─── Constantes Vault ──────────────────────────────────────────────────────
const VAULT_COOLDOWN_MS    = 30_000;           // 30s entre reveals por usuario
const VAULT_BULK_THRESHOLD = 5;                // > 5 reveals/hora = alerta
const VAULT_BULK_WINDOW_MS = 60 * 60_000;      // ventana de 60 min

// ─── VAULT_KEY desde env (NUNCA JWT_SECRET) ───────────────────────────────
function _resolveVaultKey() {
  const b64 = process.env.VAULT_KEY || '';
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    // AES-256 requiere key de 32 bytes. Si la env var está mal seteada
    // (longitud incorrecta) fallamos al boot del crypto, no al hit del
    // endpoint — esto es defensa pre-flight.
    if (buf.length !== 32) {
      console.error(`[VAULT] VAULT_KEY length=${buf.length} bytes, expected 32. Vault disabled.`);
      return null;
    }
    return buf;
  } catch (e) {
    console.error('[VAULT] VAULT_KEY base64 decode failed:', e.message);
    return null;
  }
}

const _VAULT_KEY = _resolveVaultKey();
if (!_VAULT_KEY) {
  console.warn('[VAULT] WARNING: VAULT_KEY not set or invalid — credential vault disabled.');
}

/**
 * Cifra password con AES-256-GCM. IV random 12 bytes (nonce GCM).
 * authTag (16 bytes) concatenado al ciphertext para almacenamiento atómico.
 * Output base64. Cyber Neo: nunca logueamos plaintext, ni siquiera en throw.
 */
function vaultEncrypt(plaintext) {
  if (!_VAULT_KEY) throw new VaultError(503, 'VAULT_DISABLED', 'Vault deshabilitado (VAULT_KEY no configurada).');
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _VAULT_KEY, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return {
    passwordEnc: Buffer.concat([enc, tag]).toString('base64'),
    passwordIv:  iv.toString('base64'),
  };
}

/**
 * Descifra. Verifica authTag antes de devolver plaintext — si el ciphertext
 * fue alterado (rotación de VAULT_KEY entre store/retrieve, manipulación
 * directa de DB), crypto.final() throws y respondemos error genérico.
 */
function vaultDecrypt(passwordEnc, passwordIv) {
  if (!_VAULT_KEY) throw new VaultError(503, 'VAULT_DISABLED', 'Vault deshabilitado (VAULT_KEY no configurada).');
  const data = Buffer.from(passwordEnc, 'base64');
  const tag  = data.subarray(data.length - 16);
  const enc  = data.subarray(0, data.length - 16);
  const iv   = Buffer.from(passwordIv, 'base64');
  const dec  = crypto.createDecipheriv('aes-256-gcm', _VAULT_KEY, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
}

function createCredencialesService(deps) {
  const { repo, auditReq, vaultLastReveal } = deps;
  if (!repo)                                throw new Error('createCredencialesService: repo required');
  if (typeof auditReq !== 'function')       throw new Error('createCredencialesService: auditReq required');
  if (!(vaultLastReveal instanceof Map))    throw new Error('createCredencialesService: vaultLastReveal Map required (shared con middlewares.vaultCooldownGuard)');

  // Bulk reveal tally LOCAL al service (no se comparte con MW — el MW solo
  // hace cooldown, la detección de bulk es responsabilidad del service).
  const _bulkTally = new Map();   // userId -> [timestamps ms]

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

  /**
   * Detección de bulk exfil: > THRESHOLD reveals/ventana. Solo crea
   * incidencia UNA vez por ventana (al cruzar exactamente threshold+1)
   * para evitar spam de alertas.
   */
  async function _detectarBulkReveal(user, reqMeta) {
    const uid = user?.sub;
    if (!uid) return;
    const now = Date.now();
    const arr = (_bulkTally.get(uid) ?? []).filter(t => now - t < VAULT_BULK_WINDOW_MS);
    arr.push(now);
    _bulkTally.set(uid, arr);
    if (arr.length === VAULT_BULK_THRESHOLD + 1) {
      auditReq('vault:bulk_reveal_alert', _fakeReqForAudit(reqMeta, user), { count: arr.length, ventanaMin: 60 }, { userId: uid });
      try {
        await repo.crearIncidenciaBulkAlert({
          tipo:        'BULK_VAULT_REVEAL',
          severidad:   'CRITICA',
          descripcion: `Usuario ${user.nombre} reveló > ${VAULT_BULK_THRESHOLD} credenciales en 60 min (${arr.length} totales). Posible exfiltración masiva.`,
          datos:       { userId: uid, nombre: user.nombre, count: arr.length, ip: reqMeta?.ip },
          asignadoA:   uid,
        });
      } catch (e) { console.error('[BULK ALERT INSERT]', e.message); }
    }
  }

  // ─── Listar (sin password) ──────────────────────────────────────────────
  async function listarCredenciales(query) {
    const where = query.clienteId ? { clienteId: query.clienteId } : {};
    const data = await repo.listCredenciales(where);
    return { status: 200, body: { data } };
  }

  // ─── Crear (encrypt antes de persistir) ─────────────────────────────────
  async function crearCredencial(dto, user, reqMeta) {
    if (!_VAULT_KEY) throw new VaultError(503, 'VAULT_DISABLED', 'Vault deshabilitado (VAULT_KEY no configurada).');
    let cifrado;
    try {
      cifrado = vaultEncrypt(dto.password);
    } catch {
      // NO leak del plaintext en error genérico.
      throw new VaultError(500, 'ENCRYPT_FAIL', 'Error cifrando credencial.');
    }
    try {
      const credencial = await repo.createCredencial({
        clienteId:   dto.clienteId,
        tipo:        dto.tipo,
        nombre:      dto.nombre,
        ip:          dto.ip ?? null,
        usuario:     dto.usuario,
        passwordEnc: cifrado.passwordEnc,
        passwordIv:  cifrado.passwordIv,
        notas:       dto.notas ?? null,
      });
      auditReq('vault:crear', _fakeReqForAudit(reqMeta, user), {
        credencialId: credencial.id, clienteId: dto.clienteId, tipo: dto.tipo,
      });
      return { status: 201, body: credencial };
    } catch (e) {
      if (e.code === 'P2003') throw new VaultError(400, 'CLIENTE_NOT_FOUND', 'Cliente no encontrado.');
      throw e;
    }
  }

  // ─── Reveal (TOTP + cooldown ya gateados en MW; este service solo
  // descifra + audita + bulk-detect) ─────────────────────────────────────
  async function revelarPassword(id, user, reqMeta) {
    if (!_VAULT_KEY) throw new VaultError(503, 'VAULT_DISABLED', 'Vault deshabilitado.');
    const c = await repo.findCredencialForReveal(id);
    if (!c) throw new VaultError(404, 'NOT_FOUND', 'Credencial no encontrada.');

    let password;
    try {
      password = vaultDecrypt(c.passwordEnc, c.passwordIv);
    } catch {
      // El authTag falló (rotación de key o manipulación de DB). NO leak
      // de detalles internos al cliente — solo error genérico.
      throw new VaultError(500, 'DECRYPT_FAIL', 'Error al descifrar credencial.');
    }

    // Actualiza el Map compartido con vaultCooldownGuard de
    // shared/middlewares.js. La próxima reveal del mismo user verá este
    // timestamp y bloqueará por 30s.
    vaultLastReveal.set(user.sub, Date.now());

    auditReq('vault:reveal', _fakeReqForAudit(reqMeta, user), {
      credencialId: c.id, clienteId: c.clienteId, tipo: c.tipo, nombre: c.nombre,
    });

    // Fire-and-forget bulk detect (no bloquea respuesta).
    _detectarBulkReveal(user, reqMeta).catch(e => console.error('[BULK DETECT]', e.message));

    // RESPONSE: solo password. Sin metadata adicional para reducir
    // surface de log accidental.
    return { status: 200, body: { password } };
  }

  // ─── Eliminar ──────────────────────────────────────────────────────────
  async function eliminarCredencial(id, user, reqMeta) {
    try {
      await repo.deleteCredencial(id);
      auditReq('vault:eliminar', _fakeReqForAudit(reqMeta, user), { credencialId: id });
      return { status: 204, body: null };
    } catch (e) {
      if (e.code === 'P2025') throw new VaultError(404, 'NOT_FOUND', 'Credencial no encontrada.');
      throw e;
    }
  }

  return {
    VaultError,
    vaultEnabled: () => !!_VAULT_KEY,
    listarCredenciales,
    crearCredencial,
    revelarPassword,
    eliminarCredencial,
  };
}

module.exports = createCredencialesService;
module.exports.VaultError = VaultError;
// Export crypto helpers para tests directos (NO usar fuera de este módulo).
module.exports._vaultEncrypt = vaultEncrypt;
module.exports._vaultDecrypt = vaultDecrypt;
