/**
 * backend/modules/admin/empresa/ncf/repo.js
 *
 * Repo del sub-módulo NCF admin. Delega TODO acceso a Prisma al
 * shared/services/ncf.service.js — el sub-módulo NO accede directo a la
 * tabla ConfiguracionNCF.
 *
 * Esta capa existe solo para satisfacer el Blueprint (5 archivos) y para
 * dar un punto de extensión futura (cache local de configs, métricas, etc.)
 * sin modificar el service compartido.
 *
 * Factory: createNcfRepo({ ncfService })
 */

function createNcfRepo({ ncfService }) {
  if (!ncfService)                                         throw new Error('createNcfRepo: ncfService required');
  if (typeof ncfService.listConfiguraciones !== 'function') throw new Error('createNcfRepo: ncfService.listConfiguraciones required');
  if (typeof ncfService.upsertConfiguracion !== 'function') throw new Error('createNcfRepo: ncfService.upsertConfiguracion required');

  async function listConfiguraciones() {
    return ncfService.listConfiguraciones();
  }

  async function upsertConfiguracion(data) {
    return ncfService.upsertConfiguracion(data);
  }

  return { listConfiguraciones, upsertConfiguracion };
}

module.exports = createNcfRepo;
