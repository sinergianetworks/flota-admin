-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Sincronización automática del kilometraje
--
-- pg_cron llama a la edge function sync-mileage con pg_net. La URL del
-- proyecto y el secreto compartido NO van en esta migración: se guardan una
-- sola vez en Supabase Vault (ver docs/INSTALACION.md, paso "Activar el cron"):
--
--   select vault.create_secret('https://<ref>.supabase.co', 'flota_project_url');
--   select vault.create_secret('<secreto-largo-aleatorio>', 'flota_sync_secret');
--
-- y el mismo secreto se configura en la función:
--   supabase secrets set SYNC_CRON_SECRET=<secreto-largo-aleatorio>
--
-- Mientras falten esos secretos, los jobs no hacen nada (solo un aviso).
-- ─────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Llama a sync-mileage para 'today' o 'yesterday' (resueltos en APP_TIMEZONE
-- por la propia función). Devuelve el id de la petición de pg_net.
create or replace function public.flota_request_mileage_sync(p_day text default 'yesterday')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url     text;
  v_secret  text;
  v_request bigint;
begin
  if p_day not in ('today', 'yesterday') then
    raise exception 'p_day debe ser today o yesterday';
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'flota_project_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'flota_sync_secret';

  if v_url is null or v_secret is null then
    raise notice 'Flota Admin: faltan los secretos flota_project_url / flota_sync_secret en Vault; no se sincroniza.';
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/sync-mileage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret
    ),
    body := jsonb_build_object('date', p_day),
    timeout_milliseconds := 30000
  ) into v_request;

  return v_request;
end;
$$;

-- Solo la usan pg_cron (como postgres) o un superusuario desde el SQL Editor.
revoke execute on function public.flota_request_mileage_sync(text) from public, anon, authenticated;

-- Reprogramación idempotente: si los jobs existen, se reemplazan.
do $$
begin
  perform cron.unschedule(jobname)
    from cron.job
    where jobname in ('flota-sync-km-hoy', 'flota-sync-km-ayer');
end;
$$;

-- Cada hora: km del día en curso, para que la gráfica muestre el día actual.
select cron.schedule(
  'flota-sync-km-hoy',
  '5 * * * *',
  $$ select public.flota_request_mileage_sync('today') $$
);

-- Cada 6 horas: cierra el día anterior. Como el cron corre en UTC y cada
-- instalación tiene su propia zona horaria, así siempre hay una ejecución
-- dentro de las 6 h posteriores a la medianoche local.
select cron.schedule(
  'flota-sync-km-ayer',
  '20 */6 * * *',
  $$ select public.flota_request_mileage_sync('yesterday') $$
);
