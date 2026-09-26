-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Perfiles de usuario y roles
--
-- Cada usuario de auth.users tiene un perfil con su rol:
--   admin  → gestiona toda la flota y los usuarios
--   driver → ve solo el vehículo que tiene asignado
-- ─────────────────────────────────────────────────────────────

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  phone       text,
  role        text not null default 'driver' check (role in ('admin', 'driver')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.profiles is 'Perfil y rol de cada usuario (admin | driver).';

-- ── Alta automática del perfil ───────────────────────────────
-- Todo usuario nuevo entra como conductor. El rol NO se toma de
-- user_metadata (lo controla quien se registra); lo asigna después
-- la edge function create-user o el SQL de bootstrap del primer admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, phone)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1)),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Mantiene profiles.email alineado si el correo cambia en Auth.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();

-- Evita quedarse sin administradores: no se puede degradar ni
-- desactivar al último admin activo.
create or replace function public.prevent_last_admin_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'admin' and old.active
     and (new.role <> 'admin' or not new.active)
     and not exists (
       select 1 from public.profiles
       where role = 'admin' and active and id <> old.id
     )
  then
    raise exception 'Debe quedar al menos un administrador activo.';
  end if;
  return new;
end;
$$;

create trigger profiles_keep_one_admin
  before update of role, active on public.profiles
  for each row execute function public.prevent_last_admin_removal();

-- ── Helpers de rol ───────────────────────────────────────────
-- SECURITY DEFINER para poder leer profiles desde las políticas sin
-- recursión de RLS. Un usuario desactivado no tiene rol: pierde el
-- acceso aunque su JWT siga vigente.

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'admin', false)
$$;

revoke execute on function public.current_user_role() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Cada usuario ve su propio perfil; el admin ve todos.
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- Solo el admin edita perfiles (nombre, teléfono, rol, activo).
-- Las altas llegan por el trigger y las bajas por auth.users (cascade).
create policy "profiles_update_admin" on public.profiles
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Privilegios por columna: id y email no se editan desde la API.
revoke all on public.profiles from anon;
revoke insert, update, delete on public.profiles from authenticated;
grant update (full_name, phone, role, active) on public.profiles to authenticated;
