-- AlterTable
ALTER TABLE "Compra" ADD COLUMN     "esGastoInformal" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "suplidorId" DROP NOT NULL,
ALTER COLUMN "ncfProveedor" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Compra_esGastoInformal_idx" ON "Compra"("esGastoInformal");

