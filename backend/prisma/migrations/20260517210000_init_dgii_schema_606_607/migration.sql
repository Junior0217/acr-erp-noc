-- AlterTable
ALTER TABLE "Factura" ADD COLUMN     "fechaRetencion" TIMESTAMP(3),
ADD COLUMN     "impuestoSelectivoConsumo" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "isrPercibido" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "itbisPercibido" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "itbisRetenidoTercero" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "otrosImpuestos" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "propinaLegal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "retencionRentaTercero" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tipoIngreso" TEXT NOT NULL DEFAULT '01';

-- CreateTable
CREATE TABLE "Compra" (
    "id" TEXT NOT NULL,
    "noCompra" TEXT NOT NULL,
    "suplidorId" TEXT NOT NULL,
    "ncfProveedor" TEXT NOT NULL,
    "ncfModificado" TEXT,
    "tipoBienServicio" TEXT NOT NULL,
    "fechaComprobante" TIMESTAMP(3) NOT NULL,
    "fechaPago" TIMESTAMP(3),
    "formaPago" TEXT NOT NULL,
    "montoServicios" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "montoBienes" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "itbisFacturado" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "itbisRetenido" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "itbisProporcionalidad" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "itbisLlevadoCosto" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "itbisPorAdelantar" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "itbisPercibido" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tipoRetencionIsr" TEXT,
    "montoRetencionRenta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isrPercibido" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impuestoSelectivoConsumo" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otrosImpuestos" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "propinaLegal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notas" TEXT,
    "empleadoId" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReporteDGIIGenerado" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "rncEmpresa" TEXT NOT NULL,
    "cantidadRegistros" INTEGER NOT NULL,
    "totalMonto" DECIMAL(14,2) NOT NULL,
    "totalItbis" DECIMAL(14,2) NOT NULL,
    "sha256" TEXT NOT NULL,
    "archivoUrl" TEXT,
    "empleadoId" INTEGER NOT NULL,
    "ipGeneracion" TEXT,
    "userAgent" TEXT,
    "generadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReporteDGIIGenerado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Compra_noCompra_key" ON "Compra"("noCompra");

-- CreateIndex
CREATE INDEX "Compra_suplidorId_idx" ON "Compra"("suplidorId");

-- CreateIndex
CREATE INDEX "Compra_ncfProveedor_idx" ON "Compra"("ncfProveedor");

-- CreateIndex
CREATE INDEX "Compra_fechaComprobante_idx" ON "Compra"("fechaComprobante");

-- CreateIndex
CREATE INDEX "Compra_deletedAt_idx" ON "Compra"("deletedAt");

-- CreateIndex
CREATE INDEX "Compra_suplidorId_fechaComprobante_idx" ON "Compra"("suplidorId", "fechaComprobante");

-- CreateIndex
CREATE INDEX "Compra_tipoBienServicio_idx" ON "Compra"("tipoBienServicio");

-- CreateIndex
CREATE INDEX "ReporteDGIIGenerado_tipo_idx" ON "ReporteDGIIGenerado"("tipo");

-- CreateIndex
CREATE INDEX "ReporteDGIIGenerado_periodo_idx" ON "ReporteDGIIGenerado"("periodo");

-- CreateIndex
CREATE INDEX "ReporteDGIIGenerado_generadoEn_idx" ON "ReporteDGIIGenerado"("generadoEn");

-- CreateIndex
CREATE INDEX "ReporteDGIIGenerado_tipo_periodo_idx" ON "ReporteDGIIGenerado"("tipo", "periodo");

-- CreateIndex
CREATE INDEX "ReporteDGIIGenerado_rncEmpresa_idx" ON "ReporteDGIIGenerado"("rncEmpresa");

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_suplidorId_fkey" FOREIGN KEY ("suplidorId") REFERENCES "Suplidor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReporteDGIIGenerado" ADD CONSTRAINT "ReporteDGIIGenerado_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

