/**
 * backend/modules/inventario/uploads/repo.js
 *
 * Adapter de Supabase Storage. El "repo" en este sub-módulo NO es Prisma —
 * es la capa de persistencia binaria (object storage). Encapsula:
 *   - upload con cache-control + upsert:false
 *   - getPublicUrl para devolver URL CDN servible.
 *
 * Factory: createUploadsRepo({ supabase, INVENTORY_BUCKET })
 */

function createUploadsRepo({ supabase, INVENTORY_BUCKET }) {
  // supabase puede ser null en dev/staging sin SUPABASE_SERVICE_ROLE_KEY. El
  // service hace gate con _ensureStorageReady() y devuelve 503; el repo solo
  // valida en runtime cuando alguien intenta subir.
  if (!INVENTORY_BUCKET) throw new Error('createUploadsRepo: INVENTORY_BUCKET required');

  async function uploadFile(path, buffer, contentType) {
    if (!supabase) {
      const err = new Error('Supabase storage no configurado.');
      err.code  = 'STORAGE_DISABLED';
      throw err;
    }
    const { error } = await supabase.storage.from(INVENTORY_BUCKET).upload(path, buffer, {
      contentType,
      cacheControl: '3600',
      upsert:       false,
    });
    if (error) {
      const err = new Error(error.message);
      err.code  = 'STORAGE_UPLOAD_FAIL';
      throw err;
    }
    const { data: pub } = supabase.storage.from(INVENTORY_BUCKET).getPublicUrl(path);
    return pub?.publicUrl ?? null;
  }

  return { uploadFile };
}

module.exports = createUploadsRepo;
