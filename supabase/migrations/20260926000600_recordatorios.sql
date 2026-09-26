-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Recordatorios por correo de vencimientos
--
-- fleet_settings  umbrales de aviso (una sola fila, editable por el admin)
-- reminder_log    un registro por día para no enviar dos veces
-- vehicle_odometer  odómetro calculado con la misma regla que la app
-- Job flota-recordatorios: cada hora llama a send-reminders, que solo
-- envía a partir de las 7:00 locales y una vez por día.
-- ─────────────────────────────────────────────────────────────

create table public.fleet_settings (
  id                          boolean primary key default true check (id),
  maintenance_km_threshold    integer not null default 2000 check (maintenance_km_threshold > 0),
  maintenance_days_threshold  integer not null default 15 check (maintenance_days_threshold > 0),
  insurance_days_threshold    integer not null default 30 check (insurance_days_threshold > 0),
  email_reminders_enabled     boolean not null default true,
  updated_at                  timestamptz not null default now()
);

comment on table public.fleet_settings is 'Configuración de la instalación (una sola fila). Umbrales de aviso compartidos por la app y los correos.';

insert into public.fleet_settings (id) values (true);

alter table public.fleet_settings enable row level security;

create policy "fleet_settings_select" on public.fleet_settings
  for select to authenticated
  using (true);

create policy "fleet_settings_update_admin" on public.fleet_settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.fleet_settings from anon;
revoke insert, delete on public.fleet_settings from authenticated;

-- ── Registro de envíos ───────────────────────────────────────
create table public.reminder_log (
  id          uuid primary key default gen_random_uuid(),
  local_date  date not null unique,
  status      text not null check (status in ('sent', 'nothing_to_send', 'disabled', 'error')),
  recipients  text[] not null default '{}',
  item_count  integer not null default 0,
  error       text,
  created_at  timestamptz not null default now()
);

alter table public.reminder_log enable row level security;
revoke all on public.reminder_log from anon, authenticated;

-- ── Odómetro calculado ───────────────────────────────────────
-- Con GPS: odómetro base + Σ km diarios.
-- Sin GPS: el mayor entre el odómetro base y la última lectura de la bitácora.
-- security_invoker: respeta la RLS de quien consulta.
create view public.vehicle_odometer
with (security_invoker = true) as
select
  v.id as vehicle_id,
  case
    when v.gps_device_id is not null then v.odometer_offset + coalesce(m.total_km, 0)
    else greatest(v.odometer_offset, coalesce(l.odometer_km, 0))
  end as odometer_km,
  case when v.gps_device_id is not null then 'gps' else 'manual' end as source,
  (v.gps_device_id is null and l.odometer_km is not null and l.odometer_km > v.odometer_offset) as from_log,
  case
    when v.gps_device_id is not null then (m.total_km is not null or v.odometer_offset > 0)
    else (l.odometer_km is not null or v.odometer_offset > 0)
  end as has_data
from public.vehicles v
left join lateral (
  select sum(km) as total_km
  from public.vehicle_daily_mileage
  where vehicle_id = v.id
) m on true
left join lateral (
  select odometer_km
  from public.vehicle_log
  where vehicle_id = v.id and odometer_km is not null
  order by date desc, created_at desc
  limit 1
) l on true;

revoke all on public.vehicle_odometer from anon;
grant select on public.vehicle_odometer to authenticated;

-- ── Cron ─────────────────────────────────────────────────────
create or replace function public.flota_request_reminders()
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
    raise notice 'Flota Admin: faltan los secretos flota_project_url / flota_sync_secret en Vault; no se envían recordatorios.';
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) into v_request;

  return v_request;
end;
$$;

revoke execute on function public.flota_request_reminders() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname = 'flota-recordatorios';
end;
$$;

select cron.schedule(
  'flota-recordatorios',
  '10 * * * *',
  $$ select public.flota_request_reminders() $$
);
