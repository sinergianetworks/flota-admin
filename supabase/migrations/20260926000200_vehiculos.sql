-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Vehículos, bitácora, kilometraje y caché GPS
-- ─────────────────────────────────────────────────────────────

-- ── vehicles ─────────────────────────────────────────────────
create table public.vehicles (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  plate                  text,
  chassis_number         text,
  -- Rutas dentro de los buckets privados (no URLs públicas).
  photo_url              text,
  -- Proveedor GPS (id registrado en supabase/functions/_shared/gps/providers)
  -- y el identificador del equipo en ese proveedor (p. ej. el IMEI).
  gps_provider           text,
  gps_device_id          text,
  -- Kilometraje real al instalar el GPS (o de referencia si no hay GPS).
  odometer_offset        numeric(12, 2) not null default 0,
  assigned_driver_id     uuid references public.profiles (id) on delete set null,
  next_maintenance_km    numeric(12, 2),
  next_maintenance_date  date,
  notes                  text,
  active                 boolean not null default true,
  insurance_company      text,
  insurance_policy       text,
  insurance_expiry       date,
  insurance_doc_url      text,
  created_at             timestamptz not null default now(),

  -- Proveedor y dispositivo van juntos: los dos o ninguno.
  constraint vehicles_gps_pair check ((gps_provider is null) = (gps_device_id is null))
);

comment on column public.vehicles.photo_url is 'Ruta en el bucket vehicle-photos (<vehicle_id>/archivo).';
comment on column public.vehicles.insurance_doc_url is 'Ruta en el bucket vehicle-docs (<vehicle_id>/archivo).';
comment on column public.vehicles.gps_provider is 'Id del proveedor GPS; null si el vehículo no tiene GPS (km manuales).';

create index vehicles_active_idx on public.vehicles (active);
create index vehicles_assigned_driver_idx on public.vehicles (assigned_driver_id);
-- Un mismo equipo GPS no puede estar en dos vehículos.
create unique index vehicles_gps_device_uidx
  on public.vehicles (gps_provider, gps_device_id)
  where gps_device_id is not null;

-- ── vehicle_log (bitácora) ───────────────────────────────────
create table public.vehicle_log (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles (id) on delete cascade,
  type         text not null check (type in ('maintenance', 'repair', 'part', 'fuel', 'note')),
  description  text not null,
  cost         numeric(12, 2),
  date         date not null default current_date,
  odometer_km  numeric(12, 2),
  created_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now()
);

create index vehicle_log_vehicle_date_idx on public.vehicle_log (vehicle_id, date desc, created_at desc);
create index vehicle_log_created_by_idx on public.vehicle_log (created_by);

-- ── vehicle_daily_mileage ────────────────────────────────────
-- Km recorridos por día (en la zona horaria APP_TIMEZONE), escritos por
-- la edge function sync-mileage. unique(vehicle_id, date) permite
-- upserts idempotentes: re-sincronizar un día lo sobrescribe.
create table public.vehicle_daily_mileage (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.vehicles (id) on delete cascade,
  date        date not null,
  km          numeric(10, 2) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vehicle_id, date)
);

-- ── gps_cache ────────────────────────────────────────────────
-- Caché compartida entre instancias de las edge functions (tokens de
-- acceso, listas de dispositivos). Solo la usa el service role.
create table public.gps_cache (
  provider    text not null,
  key         text not null,
  value       text not null,
  expires_at  timestamptz not null,
  primary key (provider, key)
);

-- ── Helper de acceso por vehículo ────────────────────────────
-- true si el usuario actual es admin, o es el conductor asignado de
-- un vehículo activo. SECURITY DEFINER para evitar recursión de RLS.
create or replace function public.can_access_vehicle(p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin()
    or (
      public.current_user_role() is not null
      and exists (
        select 1 from public.vehicles v
        where v.id = p_vehicle_id
          and v.active
          and v.assigned_driver_id = auth.uid()
      )
    )
$$;

revoke execute on function public.can_access_vehicle(uuid) from public, anon;
grant execute on function public.can_access_vehicle(uuid) to authenticated;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.vehicles enable row level security;
alter table public.vehicle_log enable row level security;
alter table public.vehicle_daily_mileage enable row level security;
alter table public.gps_cache enable row level security;

-- vehicles: el admin hace todo; el conductor solo lee su vehículo activo
-- (incluidos los datos del seguro).
create policy "vehicles_select" on public.vehicles
  for select to authenticated
  using (
    (select public.is_admin())
    or (
      active
      and assigned_driver_id = (select auth.uid())
      and (select public.current_user_role()) is not null
    )
  );

create policy "vehicles_insert_admin" on public.vehicles
  for insert to authenticated
  with check ((select public.is_admin()));

create policy "vehicles_update_admin" on public.vehicles
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "vehicles_delete_admin" on public.vehicles
  for delete to authenticated
  using ((select public.is_admin()));

-- vehicle_log: el conductor lee la bitácora de su vehículo y agrega
-- entradas firmadas por él; no edita ni borra. El admin hace todo.
create policy "vehicle_log_select" on public.vehicle_log
  for select to authenticated
  using (public.can_access_vehicle(vehicle_id));

create policy "vehicle_log_insert" on public.vehicle_log
  for insert to authenticated
  with check (
    (select public.is_admin())
    or (
      public.can_access_vehicle(vehicle_id)
      and created_by = (select auth.uid())
    )
  );

create policy "vehicle_log_update_admin" on public.vehicle_log
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "vehicle_log_delete_admin" on public.vehicle_log
  for delete to authenticated
  using ((select public.is_admin()));

-- vehicle_daily_mileage: lectura para quien accede al vehículo. Escribe
-- sync-mileage con el service role (que ignora RLS); el admin también
-- puede corregir a mano.
create policy "mileage_select" on public.vehicle_daily_mileage
  for select to authenticated
  using (public.can_access_vehicle(vehicle_id));

create policy "mileage_insert_admin" on public.vehicle_daily_mileage
  for insert to authenticated
  with check ((select public.is_admin()));

create policy "mileage_update_admin" on public.vehicle_daily_mileage
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "mileage_delete_admin" on public.vehicle_daily_mileage
  for delete to authenticated
  using ((select public.is_admin()));

-- gps_cache: sin políticas → inaccesible para anon/authenticated.

-- ── Privilegios ──────────────────────────────────────────────
-- anon no tiene nada que hacer en estas tablas.
revoke all on public.vehicles, public.vehicle_log, public.vehicle_daily_mileage, public.gps_cache from anon;
revoke all on public.gps_cache from authenticated;
