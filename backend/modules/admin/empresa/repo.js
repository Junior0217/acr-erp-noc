/**
 * backend/modules/admin/empresa/repo.js
 *
 * Cyber Neo: GET público usa SELECT explícito sin PII del representante
 * (cédula, nombre, cargo). Solo membrete + logos.
 */

const EMPRESA_PUBLIC_SELECT = {
  rnc: true, razonSocial: true, nombreComercial: true, registroMercantil: true,
  direccion: true, sector: true, provincia: true, pais: true,
  telefono: true, email: true, website: true, assets: true, eslogan: true,
};

function createEmpresaRepo(prisma) {
  if (!prisma) throw new Error('createEmpresaRepo: prisma required');

  async function findPublic() {
    return prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: EMPRESA_PUBLIC_SELECT,
    });
  }

  async function findFull() {
    return prisma.empresaPerfil.findUnique({ where: { id: 1 } });
  }

  async function findSecuenciasConfig() {
    return prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { secuenciasConfig: true },
    });
  }

  async function upsertSecuencias(secuenciasConfig) {
    return prisma.empresaPerfil.upsert({
      where:  { id: 1 },
      update: { secuenciasConfig },
      create: { id: 1, rnc: '', razonSocial: 'Empresa', secuenciasConfig },
    });
  }

  async function findAssets() {
    return prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { assets: true },
    });
  }

  async function upsertEmpresa(data) {
    return prisma.empresaPerfil.upsert({
      where:  { id: 1 },
      update: data,
      create: { id: 1, rnc: data.rnc ?? '', razonSocial: data.razonSocial ?? 'Empresa', ...data },
    });
  }

  // Bulk migration
  async function listProductosConDescripcion() {
    return prisma.producto.findMany({
      where:  { descripcion: { not: null } },
      select: { id: true, descripcion: true },
    });
  }

  async function updateProductoDescripcion(id, descripcion) {
    return prisma.producto.update({ where: { id }, data: { descripcion } });
  }

  async function listItemCatalogoConDescripcion() {
    return prisma.itemCatalogo.findMany({
      where:  { descripcion: { not: null } },
      select: { id: true, descripcion: true },
    });
  }

  async function updateItemCatalogoDescripcion(id, descripcion) {
    return prisma.itemCatalogo.update({ where: { id }, data: { descripcion } });
  }

  return {
    EMPRESA_PUBLIC_SELECT,
    findPublic,
    findFull,
    findSecuenciasConfig,
    upsertSecuencias,
    findAssets,
    upsertEmpresa,
    listProductosConDescripcion,
    updateProductoDescripcion,
    listItemCatalogoConDescripcion,
    updateItemCatalogoDescripcion,
  };
}

module.exports = createEmpresaRepo;
