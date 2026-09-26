-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Las funciones de trigger no se exponen por RPC
--
-- Supabase otorga EXECUTE sobre las funciones de public a anon y
-- authenticated. Estas solo tienen sentido como triggers (Postgres no deja
-- llamarlas de otra forma), pero se revoca el permiso para que no
-- aparezcan en la API.
-- ─────────────────────────────────────────────────────────────

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_user_email_change() from public, anon, authenticated;
revoke execute on function public.prevent_last_admin_removal() from public, anon, authenticated;
revoke execute on function public.try_uuid(text) from public, anon;
