-- ─────────────────────────────────────────────────────────────
-- Flota Admin · Storage: fotos de vehículos y documentos de seguro
--
-- Buckets PRIVADOS. Los archivos se guardan en <vehicle_id>/<archivo>
-- y el frontend los muestra con URLs firmadas de corta duración.
--   admin     → sube, reemplaza, borra y lee todo
--   conductor → solo lee los archivos de su vehículo
-- ─────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('vehicle-photos', 'vehicle-photos', false, 5242880,
    array['image/jpeg', 'image/png', 'image/webp']),
  ('vehicle-docs', 'vehicle-docs', false, 10485760,
    array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Convierte texto a uuid sin fallar (null si no es un uuid válido).
create or replace function public.try_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

-- El primer segmento de la ruta es el id del vehículo.
create policy "flota_archivos_select" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('vehicle-photos', 'vehicle-docs')
    and public.can_access_vehicle(public.try_uuid((storage.foldername(name))[1]))
  );

create policy "flota_archivos_insert_admin" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('vehicle-photos', 'vehicle-docs')
    and (select public.is_admin())
  );

create policy "flota_archivos_update_admin" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('vehicle-photos', 'vehicle-docs')
    and (select public.is_admin())
  )
  with check (
    bucket_id in ('vehicle-photos', 'vehicle-docs')
    and (select public.is_admin())
  );

create policy "flota_archivos_delete_admin" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('vehicle-photos', 'vehicle-docs')
    and (select public.is_admin())
  );
