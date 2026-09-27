-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Reporte semanal y destinatarios configurables
--
-- fleet_settings: lista de destinatarios, reporte semanal (activo y día).
-- reminder_log: tipo de envío (daily | weekly); un envío por tipo y día.
-- flota_claim_notification: reserva atómica por tipo (reemplaza a
--   flota_claim_reminder_day).
-- Job flota-reporte-semanal: cada hora llama a send-weekly-report, que decide
--   si hoy corresponde enviar.
-- ─────────────────────────────────────────────────────────────

-- Lista de correos válida: hasta 50 (límite de Resend) y cada uno con formato de correo.
create or replace function public.flota_valid_emails(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_length(p, 1), 0) <= 50
     and not exists (
       select 1 from unnest(p) as e
       where e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     )
$$;

revoke execute on function public.flota_valid_emails(text[]) from public, anon;

alter table public.fleet_settings
  add column notification_emails text[] not null default '{}'
    constraint fleet_settings_notification_emails_valid check (public.flota_valid_emails(notification_emails)),
  add column weekly_report_enabled boolean not null default true,
  add column weekly_report_day smallint not null default 1
    constraint fleet_settings_weekly_report_day_range check (weekly_report_day between 1 and 7);

comment on column public.fleet_settings.notification_emails is 'Destinatarios de los correos. Vacía = administradores activos.';
comment on column public.fleet_settings.weekly_report_day is 'Día del reporte semanal: 1 = lunes … 7 = domingo.';

-- El admin ya tiene update sobre toda la tabla salvo id (privilegios de 0600).
-- Por las dudas se otorga explícitamente sobre las columnas nuevas.
grant update (notification_emails, weekly_report_enabled, weekly_report_day) on public.fleet_settings to authenticated;

-- ── Tipo de envío en el registro ─────────────────────────────
alter table public.reminder_log
  add column kind text not null default 'daily'
    constraint reminder_log_kind_check check (kind in ('daily', 'weekly'));

alter table public.reminder_log drop constraint reminder_log_local_date_key;
alter table public.reminder_log add constraint reminder_log_kind_local_date_key unique (kind, local_date);

-- ── Reserva atómica por tipo ─────────────────────────────────
drop function if exists public.flota_claim_reminder_day(date);

-- true solo si (kind, fecha) no existía o estaba en 'error'; la deja en
-- 'sending'. Un 'sending' colgado cuenta como "posiblemente enviado" y no se
-- reintenta ese día.
create or replace function public.flota_claim_notification(p_kind text, p_date date)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    insert into public.reminder_log (kind, local_date, status)
    values (p_kind, p_date, 'sending')
    on conflict (kind, local_date) do update
      set status = 'sending', updated_at = now(), error = null
      where public.reminder_log.status = 'error'
    returning true
  )
  select coalesce((select true from claimed limit 1), false)
$$;

revoke execute on function public.flota_claim_notification(text, date) from public, anon, authenticated;
grant execute on function public.flota_claim_notification(text, date) to service_role;

-- ── Cron del reporte semanal ─────────────────────────────────
create or replace function public.flota_request_weekly_report()
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
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'flota_project_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'flota_sync_secret';

  if v_url is null or v_secret is null then
    raise notice 'Flota Admin: faltan los secretos flota_project_url / flota_sync_secret en Vault; no se envía el reporte semanal.';
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/send-weekly-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request;

  return v_request;
end;
$$;

revoke execute on function public.flota_request_weekly_report() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname = 'flota-reporte-semanal';
end;
$$;

select cron.schedule(
  'flota-reporte-semanal',
  '15 * * * *',
  $$ select public.flota_request_weekly_report() $$
);
