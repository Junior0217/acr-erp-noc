-- Habilita Row Level Security (RLS) en TODAS las tablas del esquema public.
-- Política única "service_role_all" permite acceso completo SOLO a los roles
-- que Prisma usa para conectarse (postgres / service_role). Bloquea el rol
-- anónimo `anon` (PostgREST) y `authenticated` (auth.users) -> ataques que
-- exploten la API REST autogenerada de Supabase no tocan estas tablas.
--
-- Idempotencia: `ENABLE ROW LEVEL SECURITY` es idempotente. Para policies
-- usamos `DROP IF EXISTS` + `CREATE` para poder re-ejecutar limpio.
--
-- Roles de Supabase relevantes:
--   - postgres        → superusuario, conexión directa de Prisma
--   - service_role    → bypass RLS por default (claim role en JWT)
--   - authenticated   → usuarios logueados por Supabase Auth (no aplica aquí)
--   - anon            → usuarios no autenticados (PostgREST público) → BLOQUEADO

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '_prisma%'
  LOOP
    -- Habilita RLS (idempotente)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);

    -- Force RLS también para el owner (asegura que ni siquiera el dueño la salte
    -- en queries no-superuser; postgres superuser sigue bypaseando)
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.tablename);

    -- Política universal: SOLO service_role + postgres (Prisma) acceden a todo.
    EXECUTE format('DROP POLICY IF EXISTS "service_role_all" ON public.%I', t.tablename);
    EXECUTE format($p$
      CREATE POLICY "service_role_all" ON public.%I
      FOR ALL
      TO postgres, service_role
      USING (true)
      WITH CHECK (true)
    $p$, t.tablename);
  END LOOP;
END $$;

-- Revoke grants públicos por si acaso (defensa en profundidad).
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
