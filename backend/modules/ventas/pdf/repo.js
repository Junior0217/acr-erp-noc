/**
 * backend/modules/ventas/pdf/repo.js
 *
 * Capa de acceso a datos del sub-módulo PDF. Único punto que toca prisma
 * para Factura/Cotizacion + EmpresaPerfil en el contexto de renderizado y
 * cacheo de PDFs.
 *
 * Factory: createPdfRepo(prisma)
 */

function createPdfRepo(prisma) {
  if (!prisma) throw new Error('createPdfRepo: prisma required');

  /** Head-only para fast path (cache hit + validación de tipo/deletedAt). */
  async function findFacturaHead(id) {
    return prisma.factura.findUnique({
      where:  { id },
      select: { pdfUrl: true, esCotizacion: true, deletedAt: true, noFactura: true, ncf: true },
    });
  }

  /** Full join para render (cliente + lineas + producto + facturaOrigen). */
  async function findFacturaForRender(id) {
    return prisma.factura.findUnique({
      where:   { id },
      include: {
        cliente:       true,
        lineas:        { include: { producto: { select: { sku: true, nombre: true } } } },
        facturaOrigen: { select: { noFactura: true, ncf: true, tipoNcf: true } },
      },
    });
  }

  /**
   * Persiste pdfUrl con CAS opcional sobre pdfInvalidatedAt — usado por el
   * cron de prerender para abortar uploads obsoletos.
   */
  async function setFacturaPdfUrl(id, url) {
    return prisma.factura.update({
      where: { id },
      data:  { pdfUrl: url },
    });
  }

  async function setFacturaPdfUrlWithCas(id, url, invalidatedAtBefore) {
    return prisma.factura.updateMany({
      where: {
        id,
        OR: [
          { pdfInvalidatedAt: null },
          { pdfInvalidatedAt: invalidatedAtBefore ?? new Date(0) },
        ],
      },
      data: { pdfUrl: url },
    });
  }

  async function incPdfRenderAttempts(id, currentAttempts) {
    return prisma.factura.update({
      where: { id },
      data:  { pdfRenderAttempts: (currentAttempts ?? 0) + 1 },
    }).catch(() => {});
  }

  /**
   * Marca factura como invalidada (pdfUrl=null + bump pdfInvalidatedAt).
   * Reset pdfRenderAttempts para que el cron la reintente.
   */
  async function invalidateFacturaCacheRow(id) {
    return prisma.factura.update({
      where: { id },
      data:  { pdfUrl: null, pdfInvalidatedAt: new Date(), pdfRenderAttempts: 0 },
    });
  }

  /** Lookup ligero para invalidar archivo en Storage. */
  async function findFacturaCacheInfo(id) {
    return prisma.factura.findUnique({
      where:  { id },
      select: { pdfUrl: true, fechaEmision: true },
    });
  }

  async function findEmpresaPerfil() {
    return prisma.empresaPerfil.findUnique({ where: { id: 1 } });
  }

  async function findEmpresaSecuenciasConfig() {
    return prisma.empresaPerfil.findUnique({
      where:  { id: 1 },
      select: { secuenciasConfig: true },
    });
  }

  async function setEmpresaSecuenciasConfig(secuenciasConfig) {
    return prisma.empresaPerfil.update({
      where: { id: 1 },
      data:  { secuenciasConfig },
    });
  }

  /**
   * Bulk reset cuando cambia PDF_TEMPLATE_VERSION o el algoritmo de verifyHash.
   * Filtra solo filas con datos cacheados/firmados — evita updateMany sin where.
   */
  async function invalidateAllCachedPdfs() {
    return prisma.factura.updateMany({
      where: { OR: [{ pdfUrl: { not: null } }, { verifyHash: { not: null } }] },
      data:  { pdfUrl: null, verifyHash: null, pdfInvalidatedAt: new Date(), pdfRenderAttempts: 0 },
    });
  }

  /**
   * Candidatos para prerender batch: docs sin pdfUrl, no borrados, emitidos en
   * los últimos 7 días, que no hayan agotado intentos. Orden por intentos
   * ascendente (los nunca intentados primero) + fechaEmision descendente.
   */
  async function findFacturasForPrerender({ desde, maxAttempts, take }) {
    return prisma.factura.findMany({
      where: {
        pdfUrl: null,
        deletedAt: null,
        fechaEmision: { gte: desde },
        pdfRenderAttempts: { lt: maxAttempts },
      },
      select:  { id: true, esCotizacion: true, noFactura: true, pdfRenderAttempts: true },
      orderBy: [{ pdfRenderAttempts: 'asc' }, { fechaEmision: 'desc' }],
      take,
    });
  }

  /** Re-fetch usado por prerender para CAS mid-flight. */
  async function findFacturaInvalidationState(id) {
    return prisma.factura.findUnique({
      where:  { id },
      select: { pdfInvalidatedAt: true, deletedAt: true },
    });
  }

  return {
    findFacturaHead,
    findFacturaForRender,
    setFacturaPdfUrl,
    setFacturaPdfUrlWithCas,
    incPdfRenderAttempts,
    invalidateFacturaCacheRow,
    findFacturaCacheInfo,
    findEmpresaPerfil,
    findEmpresaSecuenciasConfig,
    setEmpresaSecuenciasConfig,
    invalidateAllCachedPdfs,
    findFacturasForPrerender,
    findFacturaInvalidationState,
  };
}

module.exports = createPdfRepo;
