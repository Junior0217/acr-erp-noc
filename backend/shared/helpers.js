/**
 * backend/shared/helpers.js
 *
 * Pure helpers reused across server.js + routes/. Stateless, no DB access.
 * Owns: UUID validators, response envelopes, RD identifier validators &
 * formatters, body-limit factory, prototype-pollution guard, request
 * fingerprint, device hash, body parser limits.
 */

const crypto  = require('crypto');
const express = require('express');
const { z }   = require('zod');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUUID(id) { return UUID_RE.test(id); }

function rejectBadId(req, res) {
  if (!validUUID(req.params.id)) {
    res.status(400).json({ error: 'ID inválido.' });
    return true;
  }
  return false;
}

function sendErr(res, status, code, message, detail) {
  return res.status(status).json({ ok: false, error: message, code, ...(detail ? { detail } : {}) });
}

function sendOk(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

/**
 * Validador estructural de Cédula RD (Mod-10 / Luhn DGII).
 * No consulta DGII; solo verifica formato + dígito verificador.
 */
function validarCedulaRD(cedulaRaw) {
  if (typeof cedulaRaw !== 'string') return false;
  const d = cedulaRaw.replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let p = parseInt(d[i], 10) * weights[i];
    if (p > 9) p = (p % 10) + Math.floor(p / 10);
    sum += p;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(d[10], 10);
}

// DGII Fase 3 — Validador RNC (Registro Nacional del Contribuyente).
//
// Formato RD: 9 dígitos = 8 dígitos numéricos + 1 dígito verificador (mod 11).
// Algoritmo oficial DGII (canónico):
//   1) Multiplicar c1..c8 por pesos [7,9,8,6,5,4,3,2] y sumar.
//   2) mod = suma mod 11.
//   3) dv esperado:
//        mod == 0 → 2  (cero es reservado, DGII salta a 2)
//        mod == 1 → 1
//        else     → 11 - mod
//   4) dv == c9.
//
// Acepta el RNC con guiones/espacios — los limpia antes de validar.
// Rechaza secuencias triviales (000000000, 111111111, etc.).
function validarRncRD(rncRaw) {
  if (typeof rncRaw !== 'string') return false;
  const d = rncRaw.replace(/\D/g, '');
  if (d.length !== 9) return false;
  if (/^(\d)\1{8}$/.test(d)) return false;
  const weights = [7, 9, 8, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += parseInt(d[i], 10) * weights[i];
  const mod = sum % 11;
  let dv;
  if (mod === 0) dv = 2;
  else if (mod === 1) dv = 1;
  else dv = 11 - mod;
  return dv === parseInt(d[8], 10);
}

// DGII Fase 3 — Enmascarador para logs/auditReq. Deja últimos 4 dígitos.
// Ej: "130000123" -> "*****0123". Anti-PII en AuditLog.
function enmascararRnc(rncRaw) {
  if (typeof rncRaw !== 'string') return null;
  const d = rncRaw.replace(/\D/g, '');
  if (d.length < 5) return '*'.repeat(d.length);
  return '*'.repeat(d.length - 4) + d.slice(-4);
}

// DGII Fase 3 — Validador formato NCF/e-CF.
// NCF físico: B + 10 dígitos (B01 = Crédito Fiscal, B02 = Consumidor Final,
// B03 = Nota Débito, B04 = Nota Crédito, B14 = Régimen Especial).
// e-CF:       E + 10 dígitos.
function validarNcfDgii(ncfRaw) {
  if (typeof ncfRaw !== 'string') return false;
  return /^[BE]\d{10}$/.test(ncfRaw.trim().toUpperCase());
}

const emptyStr = z.literal('');
const nullStr  = (max = 20) => z.string().max(max).or(emptyStr).optional().transform(v => (v === '' || v == null) ? null : v);
const optIdent = (max = 20) => z.string().min(1).max(max).or(emptyStr).optional().transform(v => (v === '' || v == null) ? null : v);

const optCedulaRD = z.string().max(20).optional().nullable().transform(v => {
  if (v === '' || v == null) return null;
  return v;
}).superRefine((v, ctx) => {
  if (v == null) return;
  const digits = v.replace(/\D/g, '');
  if (digits.length !== 11) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cédula debe tener 11 dígitos.' });
    return;
  }
  if (!validarCedulaRD(v)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Cédula RD inválida (dígito verificador no coincide).' });
  }
});

function fmtPhone(v) {
  if (!v) return v;
  const d = String(v).replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

function fmtCedula(v) {
  if (!v) return v;
  const d = String(v).replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
}

function fmtRNC(v) {
  if (!v) return v;
  const d = String(v).replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length === 9) return `${d.slice(0, 3)}-${d.slice(3, 8)}-${d.slice(8)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
}

function formatCliente(c) {
  return {
    ...c,
    rnc:                 fmtRNC(c.rnc),
    telefonoPrincipal:   fmtPhone(c.telefonoPrincipal),
    telefonoAlternativo: fmtPhone(c.telefonoAlternativo),
    cedula:              fmtCedula(c.cedula),
    limiteCredito:       Number(c.limiteCredito),
  };
}

function formatSuplidor(s) {
  return {
    ...s,
    rnc:                 fmtRNC(s.rnc),
    telefonoPrincipal:   fmtPhone(s.telefonoPrincipal),
    telefonoAlt:         fmtPhone(s.telefonoAlt),
    cedula:              fmtCedula(s.cedula),
    limiteCredito:       Number(s.limiteCredito),
  };
}

function formatProspecto(p) {
  return { ...p, telefono: fmtPhone(p.telefono) };
}

function reqFingerprint(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? '';
  const ua = req.headers['user-agent'] ?? '';
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex');
}

/**
 * Device fingerprint endurecido: IP + UA + Accept-Language + Sec-CH-UA.
 * Trade-off: rotación de IP por ISP dispara device_nuevo (falso positivo OK).
 */
function computeDeviceHash(ua, ip, acceptLanguage = '', secChUa = '') {
  const lang = String(acceptLanguage).split(',')[0]?.trim().toLowerCase() ?? '';
  const raw  = `${ua}|${ip ?? ''}|${lang}|${secChUa}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function labelFromUA(ua) {
  if (!ua) return 'Desconocido';
  const lower = ua.toLowerCase();
  let device = 'Computadora';
  if (/iphone|android|mobile/.test(lower)) device = 'Móvil';
  else if (/ipad|tablet/.test(lower))      device = 'Tablet';
  let browser = 'Navegador';
  if (/edg\//.test(lower))      browser = 'Edge';
  else if (/chrome/.test(lower))browser = 'Chrome';
  else if (/firefox/.test(lower)) browser = 'Firefox';
  else if (/safari/.test(lower))browser = 'Safari';
  let os = 'OS';
  if (/windows nt 11/.test(lower)) os = 'Windows 11';
  else if (/windows nt 10/.test(lower)) os = 'Windows 10';
  else if (/windows/.test(lower)) os = 'Windows';
  else if (/mac os x/.test(lower)) os = 'macOS';
  else if (/android/.test(lower)) os = 'Android';
  else if (/iphone|ipad|ios/.test(lower)) os = 'iOS';
  else if (/linux/.test(lower)) os = 'Linux';
  return `${browser} en ${os} · ${device}`;
}

/**
 * Bloquea claves __proto__ / prototype / constructor en req.body antes del parser.
 * Express.json no protege por defecto.
 */
function _stripPollutionKeys(obj, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) { obj.forEach(v => _stripPollutionKeys(v, depth + 1)); return obj; }
  for (const k of Object.keys(obj)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') {
      delete obj[k];
    } else {
      _stripPollutionKeys(obj[k], depth + 1);
    }
  }
  return obj;
}

/**
 * Body-limit factory con reviver anti-pollution.
 */
function bodyLimit(maxKb) {
  return express.json({
    limit: `${maxKb}kb`,
    reviver: (k, v) => (k === '__proto__' || k === 'prototype' || k === 'constructor') ? undefined : v,
  });
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()
       || req.socket?.remoteAddress
       || 'unknown').replace(/^::ffff:/, '');
}

/**
 * stripTags — remueve cualquier marcador HTML/XML y trim. Defensa en
 * profundidad contra XSS y prototype pollution via campos string. Aplicado en
 * Zod transforms de inputs que llegan a campos de DB legibles por humanos
 * (nombre, descripción corta, SKU).
 */
function stripTags(v) {
  return typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v;
}

/**
 * Normaliza el campo "descripcion" flex (producto/itemCatalogo/línea):
 *   - null/undefined → null
 *   - string legacy → mismo string
 *   - { v:1, titulo, bullets[], imagenUrl? } → JSON serializado con caps
 *     conservadores (200 chars titulo, 200 por bullet, 30 bullets máx, 500
 *     chars en imagenUrl).
 *
 * Centralizado acá porque ~22 routers necesitan la misma normalización antes
 * de persistir. Si llega un objeto sin v=1, fall back a null para evitar
 * insertar shapes desconocidos en la DB.
 */
function descripcionToRaw(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.v === 1) {
    return JSON.stringify({
      v: 1,
      titulo:    String(value.titulo ?? '').slice(0, 200),
      bullets:   Array.isArray(value.bullets) ? value.bullets.map(b => String(b).slice(0, 200)).filter(Boolean).slice(0, 30) : [],
      imagenUrl: value.imagenUrl ? String(value.imagenUrl).slice(0, 500) : null,
    });
  }
  return null;
}

module.exports = {
  UUID_RE,
  validUUID,
  rejectBadId,
  sendErr,
  sendOk,
  validarCedulaRD,
  validarRncRD,
  enmascararRnc,
  validarNcfDgii,
  emptyStr,
  nullStr,
  optIdent,
  optCedulaRD,
  fmtPhone,
  fmtCedula,
  fmtRNC,
  formatCliente,
  formatSuplidor,
  formatProspecto,
  reqFingerprint,
  computeDeviceHash,
  labelFromUA,
  _stripPollutionKeys,
  bodyLimit,
  getClientIp,
  stripTags,
  descripcionToRaw,
};
