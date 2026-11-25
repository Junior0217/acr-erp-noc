-- Factura.preciosIncluyenItbis
-- Registra que los precios unitarios del documento se capturaron CON ITBIS
-- incluido y fueron desglosados a base imponible (modules/ventas/_lib.js →
-- desglosarItbis). El documento sigue almacenando la base; este flag conserva
-- la procedencia para poder re-editar el documento sin recalcular a mano.
ALTER TABLE "Factura" ADD COLUMN IF NOT EXISTS "preciosIncluyenItbis" BOOLEAN NOT NULL DEFAULT false;
