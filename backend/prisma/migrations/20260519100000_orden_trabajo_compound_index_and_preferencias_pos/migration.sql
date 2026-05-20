-- Índice compuesto para acelerar el listado del módulo Servicio Técnico
-- (backend/modules/servicios/ordenes/repo.js filtra OrdenTrabajo por
-- tipoOT='ServicioTecnico' + estado + orden por createdAt en cada page).
CREATE INDEX IF NOT EXISTS "OrdenTrabajo_tipoOT_estado_createdAt_idx"
  ON "OrdenTrabajo" ("tipoOT", "estado", "createdAt");

-- Preferencias del POS por cajero. 1:1 con Empleado. Persiste defaults de
-- los switches de visualización (Validez/Pago/Entrega/Garantía/Notas) para
-- que cada cajero conserve su configuración al recargar.
CREATE TABLE IF NOT EXISTS "UsuarioPreferenciasPOS" (
  "empleadoId"        INTEGER     NOT NULL,
  "mostrarValidez"    BOOLEAN     NOT NULL DEFAULT true,
  "mostrarFormaPago"  BOOLEAN     NOT NULL DEFAULT true,
  "mostrarEntrega"    BOOLEAN     NOT NULL DEFAULT true,
  "mostrarGarantia"   BOOLEAN     NOT NULL DEFAULT true,
  "mostrarNotas"      BOOLEAN     NOT NULL DEFAULT false,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsuarioPreferenciasPOS_pkey" PRIMARY KEY ("empleadoId")
);

ALTER TABLE "UsuarioPreferenciasPOS"
  ADD CONSTRAINT "UsuarioPreferenciasPOS_empleadoId_fkey"
  FOREIGN KEY ("empleadoId") REFERENCES "Empleado"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
