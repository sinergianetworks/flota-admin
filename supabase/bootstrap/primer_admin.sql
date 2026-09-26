-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Bootstrap del primer administrador (vía manual)
--
-- Alternativa a scripts/crear-primer-admin.sh. NO es una migración:
-- se ejecuta una sola vez, a mano, en el SQL Editor del proyecto.
--
-- 1. En el panel de Supabase: Authentication → Users → Add user →
--    "Create new user". Escribe el correo y la contraseña y marca
--    "Auto Confirm User".
-- 2. Reemplaza el correo y el nombre de abajo y ejecuta este SQL.
-- ─────────────────────────────────────────────────────────────

update public.profiles
set role = 'admin',
    full_name = 'Nombre del administrador',
    active = true
where email = lower('admin@tu-empresa.com')
returning id, email, full_name, role;

-- Si no devuelve ninguna fila, el correo no coincide con ningún usuario
-- de Authentication → Users. Verifica con:
--   select id, email, role from public.profiles order by created_at;
