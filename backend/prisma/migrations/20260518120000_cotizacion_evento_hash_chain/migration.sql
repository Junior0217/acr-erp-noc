-- CreateTable
CREATE TABLE "CotizacionEvento" (
    "id" SERIAL NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "prevHash" TEXT,
    "empleadoId" INTEGER,
    "ip" TEXT,
    "ua" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CotizacionEvento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CotizacionEvento_cotizacionId_idx" ON "CotizacionEvento"("cotizacionId");

-- CreateIndex
CREATE INDEX "CotizacionEvento_cotizacionId_createdAt_idx" ON "CotizacionEvento"("cotizacionId", "createdAt");

-- CreateIndex
CREATE INDEX "CotizacionEvento_accion_idx" ON "CotizacionEvento"("accion");

-- CreateIndex
CREATE INDEX "CotizacionEvento_hash_idx" ON "CotizacionEvento"("hash");

