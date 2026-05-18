-- AlterTable
ALTER TABLE "ItemCatalogo" ADD COLUMN     "planId" TEXT;

-- AlterTable
ALTER TABLE "LineaFactura" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "LineaFactura_deletedAt_idx" ON "LineaFactura"("deletedAt");

-- AddForeignKey
ALTER TABLE "ItemCatalogo" ADD CONSTRAINT "ItemCatalogo_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

