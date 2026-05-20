-- Índice de UsuarioPreferenciasPOS.updatedAt para soporte de paneles admin
-- ("últimas adopciones") y métricas (cajeros activos en N días).
CREATE INDEX IF NOT EXISTS "UsuarioPreferenciasPOS_updatedAt_idx"
  ON "UsuarioPreferenciasPOS" ("updatedAt");
