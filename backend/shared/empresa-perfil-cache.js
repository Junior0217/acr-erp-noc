/**
 * backend/shared/empresa-perfil-cache.js
 *
 * Cache en proceso del singleton EmpresaPerfil (id=1). El perfil (logo, RNC,
 * eslogan, dirección) cambia rarísimo pero se lee en CADA render de PDF
 * (facturas, cotizaciones, cotizador libre). Un TTL corto elimina round-trips
 * redundantes a BD sin servir datos rancios.
 *
 * Antes el cache vivía dentro del factory del cotizador-libre (per-instancia),
 * así que el endpoint de update de EmpresaPerfil (admin/empresa) no podía
 * invalidarlo → el PDF servía logo/RNC viejo hasta que expirara el TTL.
 * Centralizado aquí: `invalidate()` desde admin/empresa.actualizarPerfil
 * refresca al instante para TODOS los consumidores.
 *
 * Singleton de módulo (require-cache de Node) → una sola copia por proceso.
 */

const TTL_MS = 60_000;
let _cache = { value: null, at: 0 };

/**
 * Devuelve el perfil cacheado o invoca `loader()` (que hace el fetch a BD) si
 * el cache expiró/está vacío. Cachea también `null` (no hay perfil) para no
 * reconsultar en ambientes vacíos. Si `loader` lanza, degrada al último valor
 * conocido en vez de propagar (el render debe seguir con defaults).
 */
async function getEmpresaPerfilCached(loader) {
  const now = Date.now();
  if (_cache.at > 0 && (now - _cache.at) < TTL_MS) return _cache.value;
  try {
    const value = await loader();
    _cache = { value, at: now };
    return value;
  } catch {
    return _cache.value;
  }
}

/** Invalida el cache — llamar tras cualquier mutación de EmpresaPerfil. */
function invalidateEmpresaPerfilCache() {
  _cache = { value: null, at: 0 };
}

module.exports = { getEmpresaPerfilCached, invalidateEmpresaPerfilCache, TTL_MS };
