# Recordatorios por correo — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enviar cada día, a partir de las 7:00 locales, un correo a los admins activos con los mantenimientos (por km y por fecha) y los seguros próximos a vencer o vencidos. Los umbrales se configuran desde la app, y las tarjetas usan esos mismos umbrales.

**Architecture:**
- **Base de datos (una migración):**
  - `fleet_settings`, una sola fila con los umbrales;
  - `reminder_log`, para no enviar dos veces el mismo día;
  - la vista `vehicle_odometer`, con la misma regla de odómetro que la app;
  - el job de pg_cron.
- **Edge function `send-reminders`:** la llama el cron cada hora; un admin también puede llamarla en modo prueba. Usa dos módulos puros testeables (`reminders.ts` y `reminder_email.ts`) y envía por Resend.
- **Frontend:** una página de Configuración y las tarjetas leyendo los umbrales y la vista.

**Tech Stack:** Postgres/Supabase (RLS, pg_cron, pg_net, Vault), Deno edge functions, Resend (API HTTP), React + Vite, PGlite para tests de SQL.

**Spec:** `docs/superpowers/specs/2026-09-26-recordatorios-email-design.md`

**Convenciones del repo:**
- Todo el texto visible va en español.
- Los comandos se ejecutan desde la raíz `flota-admin/`, salvo que el paso diga otra cosa.
- El CLI de Supabase se usa con `npx -y supabase@latest …`, y Deno con `npx -y deno …`.
- **No** tocar el proyecto Supabase de Campo (`pxjqxhajvpwofaaolhop`). El proyecto de prueba es `oklpfxskdujpaqxnwvbf`.
- Antes de cualquier `db push`, verificar `cat supabase/.temp/project-ref`.

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `supabase/migrations/20260926000600_recordatorios.sql` | Crear | Tablas, vista, RLS y job de cron |
| `supabase/tests/db.test.mjs` | Crear | Harness PGlite: aplica todas las migraciones con stubs y prueba RLS y la vista |
| `package.json` | Modificar | devDependency `@electric-sql/pglite` y script `test:db` |
| `supabase/functions/_shared/http.ts` | Modificar | Exportar `withErrors` para testear handlers sin `Deno.serve` |
| `supabase/functions/_shared/cron.ts` | Crear | `isCronRequest(req)` (secreto compartido, comparación en tiempo constante) |
| `supabase/functions/sync-mileage/index.ts` | Modificar | Usar `isCronRequest` (DRY) |
| `supabase/functions/_shared/time.ts` | Modificar | `hourInTz`, `daysBetween` |
| `supabase/functions/_shared/reminders.ts` | Crear | Cálculo puro de avisos |
| `supabase/functions/_shared/reminder_email.ts` | Crear | Armado puro del correo (asunto, HTML y texto) |
| `supabase/functions/_shared/resend.ts` | Crear | Configuración del correo y envío por Resend |
| `supabase/functions/send-reminders/handler.ts` | Crear | Lógica de la función (testeable) |
| `supabase/functions/send-reminders/index.ts` | Crear | `serve(handler)` |
| `supabase/functions/_tests/*_test.ts` | Crear | Tests Deno |
| `supabase/config.toml` | Modificar | `[functions.send-reminders] verify_jwt = false` |
| `supabase/functions/.env.example` | Modificar | Secrets de correo |
| `src/lib/settings.ts` | Crear | `useFleetSettings`, `loadFleetSettings` y defaults |
| `src/pages/vehicles/useOdometer.ts` | Modificar | Leer de la vista `vehicle_odometer` |
| `src/pages/vehicles/VehicleCard.tsx` | Modificar | Umbrales configurables y alerta de mantenimiento por fecha |
| `src/pages/settings/SettingsPage.tsx` | Crear | Página Configuración |
| `src/App.tsx`, `src/components/Layout.tsx` | Modificar | Ruta y menú |
| `docs/INSTALACION.md`, `README.md` | Modificar | Documentación |

---

### Task 1: Harness de base de datos en el repo (PGlite)

Hoy las pruebas de RLS viven fuera del repo. Se agregan al repo para que las pruebas de esta feature (y las futuras) sean reproducibles.

**Files:**
- Create: `supabase/tests/db.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Instalar PGlite y agregar el script**

```bash
npm install --save-dev @electric-sql/pglite
npm pkg set scripts.test:db="node supabase/tests/db.test.mjs"
```

- [ ] **Step 2: Crear el harness con las pruebas actuales**

`supabase/tests/db.test.mjs`:

```js
// Aplica todas las migraciones sobre PGlite (Postgres en memoria) con stubs
// mínimos de Supabase y prueba la RLS. Uso: npm run test:db
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const db = new PGlite()

const STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

-- pg_cron, pg_net y Vault (solo lo que usan las migraciones)
create schema extensions;
create schema cron;
create table cron.job (jobid serial, jobname text unique, schedule text, command text);
create function cron.schedule(n text, s text, c text) returns bigint language sql as
  $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
create function cron.unschedule(n text) returns boolean language sql as
  $$ delete from cron.job where jobname = n returning true $$;
create schema net;
create table net.calls (id serial, url text, headers jsonb, body jsonb, timeout int);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language sql as
  $$ insert into net.calls (url, headers, body, timeout) values (url, headers, body, timeout_milliseconds) returning id $$;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

let pass = 0, fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, detail) }
}

async function as(uid, sql, params = [], role = 'authenticated') {
  await db.exec('begin')
  try {
    await db.exec(`set local role ${role}`)
    if (uid) await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { rows: r.rows, affected: r.affectedRows ?? 0 }
  } catch (e) {
    await db.exec('rollback')
    return { error: e.message }
  }
}

await db.exec(STUBS)
for (const f of readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(MIG, f), 'utf8').replace(/create extension[^;]+;/gi, '')
  try { await db.exec(sql); console.log('migración OK:', f) }
  catch (e) { console.log('migración FALLÓ:', f, '→', e.message); process.exit(1) }
}

// ── Datos base ─────────────────────────────────────────────
const users = {}
for (const [k, email, meta] of [
  ['A', 'admin@ejemplo.test', { full_name: 'Ana Admin', role: 'admin' }],
  ['D1', 'uno@ejemplo.test', { full_name: 'Conductor Uno' }],
  ['D2', 'dos@ejemplo.test', {}],
]) {
  const r = await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [email, meta])
  users[k] = r.rows[0].id
}
const { A, D1, D2 } = users
await db.query(`update public.profiles set role = 'admin' where id = $1`, [A])

let r = await as(A, `insert into public.vehicles (name, assigned_driver_id, gps_provider, gps_device_id, odometer_offset)
  values ('GPS', $1, 'tracksolid', '111', 1000), ('Manual', $2, null, null, 500), ('Libre', null, null, null, 0)
  returning id, name`, [D1, D2])
const V = Object.fromEntries(r.rows.map(x => [x.name, x.id]))

console.log('\nRLS existente')
r = await as(D1, `select name from public.vehicles`)
ok('conductor ve solo su vehículo', r.rows?.length === 1 && r.rows[0].name === 'GPS')
r = await as(D1, `update public.vehicles set notes = 'x'`)
ok('conductor no edita vehículos', !r.error && r.affected === 0)
r = await as(D1, `update public.profiles set role = 'admin' where id = $1`, [D1])
ok('conductor no se asciende', !r.error && r.affected === 0)
r = await as(null, `select * from public.vehicles`, [], 'anon')
ok('anon sin acceso a vehicles', !!r.error)

console.log(`\n${pass} OK · ${fail} fallos`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 3: Correrlo**

Run: `npm run test:db`
Expected: `migración OK` para las 5 migraciones existentes y `4 OK · 0 fallos`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json supabase/tests/db.test.mjs
git commit -m "test: harness PGlite de migraciones y RLS en el repo"
```

---

### Task 2: Migración de recordatorios (tablas, vista y cron)

**Files:**
- Create: `supabase/migrations/20260926000600_recordatorios.sql`
- Modify: `supabase/tests/db.test.mjs`

- [ ] **Step 1: Escribir las pruebas que deben fallar**

En `supabase/tests/db.test.mjs`, **antes** de la línea `console.log(\`\n${pass} OK · ${fail} fallos\`)`, agregar:

```js
console.log('\nfleet_settings')
r = await as(D1, `select maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled from public.fleet_settings`)
ok('conductor lee la configuración con los defaults', r.rows?.length === 1
  && r.rows[0].maintenance_km_threshold === 2000 && r.rows[0].maintenance_days_threshold === 15
  && r.rows[0].insurance_days_threshold === 30 && r.rows[0].email_reminders_enabled === true, JSON.stringify(r))
r = await as(D1, `update public.fleet_settings set maintenance_km_threshold = 1`)
ok('conductor no edita la configuración', !r.error && r.affected === 0)
r = await as(A, `update public.fleet_settings set maintenance_km_threshold = 1500 returning maintenance_km_threshold`)
ok('admin edita la configuración', r.rows?.[0]?.maintenance_km_threshold === 1500, JSON.stringify(r))
r = await as(A, `update public.fleet_settings set insurance_days_threshold = 0`)
ok('umbral 0 se rechaza', !!r.error)
r = await as(A, `insert into public.fleet_settings (id) values (false)`)
ok('no se insertan filas nuevas', !!r.error)
r = await as(null, `select * from public.fleet_settings`, [], 'anon')
ok('anon sin acceso a fleet_settings', !!r.error)

console.log('\nreminder_log')
r = await as(A, `select * from public.reminder_log`)
ok('admin no accede a reminder_log (solo service role)', !!r.error || r.rows.length === 0)
r = await as(null, `insert into public.reminder_log (local_date, status) values ('2026-09-26', 'sent')`, [], 'service_role')
ok('service role registra envíos', !r.error, r.error)
r = await as(null, `insert into public.reminder_log (local_date, status) values ('2026-09-26', 'sent')`, [], 'service_role')
ok('un solo registro por día', !!r.error)

console.log('\nvehicle_odometer')
await as(A, `insert into public.vehicle_daily_mileage (vehicle_id, date, km) values ($1, '2026-09-24', 10.5), ($1, '2026-09-25', 20)`, [V.GPS])
await as(A, `insert into public.vehicle_log (vehicle_id, type, description, odometer_km, date) values
  ($1, 'fuel', 'a', 700, '2026-09-20'), ($1, 'fuel', 'b', 650, '2026-09-22')`, [V.Manual])
r = await as(A, `select v.name, o.odometer_km::float as km, o.source, o.from_log, o.has_data
  from public.vehicle_odometer o join public.vehicles v on v.id = o.vehicle_id order by v.name`)
const od = Object.fromEntries((r.rows ?? []).map(x => [x.name, x]))
ok('GPS = base + Σ km diarios', od.GPS?.km === 1030.5 && od.GPS?.source === 'gps' && od.GPS?.has_data === true, JSON.stringify(od.GPS))
ok('manual = máx(base, última lectura por fecha)', od.Manual?.km === 650 && od.Manual?.source === 'manual' && od.Manual?.from_log === true, JSON.stringify(od.Manual))
ok('sin datos: has_data = false', od.Libre?.km === 0 && od.Libre?.has_data === false, JSON.stringify(od.Libre))
r = await as(D1, `select vehicle_id from public.vehicle_odometer`)
ok('la vista respeta la RLS del conductor', r.rows?.length === 1 && r.rows[0].vehicle_id === V.GPS, JSON.stringify(r))
r = await as(null, `select * from public.vehicle_odometer`, [], 'anon')
ok('anon sin acceso a la vista', !!r.error)

console.log('\ncron de recordatorios')
r = await db.query(`select schedule from cron.job where jobname = 'flota-recordatorios'`)
ok('job programado cada hora al minuto 10', r.rows[0]?.schedule === '10 * * * *')
r = await db.query(`select public.flota_request_reminders() as id`)
ok('sin secretos en Vault no llama', r.rows[0].id === null)
await db.exec(`insert into vault.decrypted_secrets values ('flota_project_url', 'https://x.supabase.co/'), ('flota_sync_secret', 's3cr3t')`)
r = await db.query(`select public.flota_request_reminders() as id`)
const call = (await db.query(`select url, headers from net.calls order by id desc limit 1`)).rows[0]
ok('con secretos llama a send-reminders', r.rows[0].id !== null && call.url === 'https://x.supabase.co/functions/v1/send-reminders' && call.headers['x-cron-secret'] === 's3cr3t', JSON.stringify(call))
r = await as(A, `select public.flota_request_reminders()`)
ok('authenticated no puede dispararlo', !!r.error)
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npm run test:db`
Expected: FAIL. Las nuevas pruebas marcan `✗`, por ejemplo `relation "public.fleet_settings" does not exist`, y la salida termina con `N fallos`.

- [ ] **Step 3: Escribir la migración**

`supabase/migrations/20260926000600_recordatorios.sql`:

```sql
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
```

- [ ] **Step 4: Correr las pruebas**

Run: `npm run test:db`
Expected: `migración OK: 20260926000600_recordatorios.sql` y `... OK · 0 fallos`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260926000600_recordatorios.sql supabase/tests/db.test.mjs
git commit -m "feat(db): configuración de umbrales, registro de recordatorios, vista de odómetro y cron"
```

---

### Task 3: Helpers compartidos de las funciones (`withErrors`, `isCronRequest`, tiempo)

**Files:**
- Modify: `supabase/functions/_shared/http.ts`
- Create: `supabase/functions/_shared/cron.ts`
- Modify: `supabase/functions/sync-mileage/index.ts`
- Modify: `supabase/functions/_shared/time.ts`
- Modify: `supabase/functions/_tests/time_test.ts`

- [ ] **Step 1: Tests de `hourInTz` y `daysBetween` (deben fallar)**

Agregar al final de `supabase/functions/_tests/time_test.ts`, y agregar `hourInTz, daysBetween` al import existente desde `'../_shared/time.ts'`:

```ts
Deno.test('hourInTz: hora local 0-23', () => {
  // 11:30 UTC = 07:30 en UTC-4
  assertEquals(hourInTz(new Date('2026-09-26T11:30:00Z'), 'America/La_Paz'), 7)
  assertEquals(hourInTz(new Date('2026-09-26T03:59:00Z'), 'America/La_Paz'), 23)
  assertEquals(hourInTz(new Date('2026-09-26T04:00:00Z'), 'America/La_Paz'), 0)
})

Deno.test('daysBetween: días de calendario', () => {
  assertEquals(daysBetween('2026-09-26', '2026-10-01'), 5)
  assertEquals(daysBetween('2026-09-26', '2026-09-26'), 0)
  assertEquals(daysBetween('2026-09-26', '2026-09-20'), -6)
  assertEquals(daysBetween('2026-02-28', '2026-03-01'), 1)
})
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/time_test.ts`
Expected: FAIL, porque `hourInTz` y `daysBetween` no se exportan desde `time.ts`.

- [ ] **Step 3: Implementar en `time.ts`**

Agregar al final de `supabase/functions/_shared/time.ts`:

```ts
// Hora (0-23) de un instante vista desde la zona `tz`.
export function hourInTz(instant: Date, tz: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant)
    .find(p => p.type === 'hour')?.value
  return Number(hour)
}

// Días de calendario de `from` a `to` (YYYY-MM-DD). Negativo si `to` es anterior.
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/time_test.ts`
Expected: PASS (9 tests).

- [ ] **Step 4b: Leer el entorno de `_shared/supabase.ts` al usarlo, no al importar**

Así varios tests pueden apuntar a servidores simulados distintos dentro del mismo proceso. En `supabase/functions/_shared/supabase.ts`:

Reemplazar:

```ts
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
```

por:

```ts
function supabaseUrl(): string {
  return Deno.env.get('SUPABASE_URL') ?? ''
}
```

Reemplazar:

```ts
export const SECRET_KEY = readKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')

// Cliente con la secret key: ignora la RLS. Usar solo después de autorizar.
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SECRET_KEY, {
```

por:

```ts
// Cliente con la secret key: ignora la RLS. Usar solo después de autorizar.
export function adminClient(): SupabaseClient {
  return createClient(supabaseUrl(), readKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), {
```

Y en `userClient`, reemplazar `createClient(SUPABASE_URL, publishable, {` por `createClient(supabaseUrl(), publishable, {`.

Verificar que nada más usaba las constantes: `grep -rn "SUPABASE_URL\|SECRET_KEY" supabase/functions --exclude-dir=_tests` solo debe mostrar lecturas de `Deno.env`.

- [ ] **Step 5: `withErrors` en `http.ts`**

En `supabase/functions/_shared/http.ts`, reemplazar la función `serve` completa por:

```ts
type Handler = (req: Request) => Promise<Response>

// Envuelve un handler: responde el preflight CORS, acepta solo POST y
// traduce errores a JSON { error }. Separado de serve() para poder testearlo.
export function withErrors(handler: Handler): Handler {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'POST') return errorResponse('Método no permitido', 405)
    try {
      return await handler(req)
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.message, err.status)
      console.error(err)
      return errorResponse('Error interno del servidor', 500)
    }
  }
}

export function serve(handler: Handler) {
  Deno.serve(withErrors(handler))
}
```

- [ ] **Step 6: Crear `_shared/cron.ts`**

```ts
// Autorización de llamadas de pg_cron: header x-cron-secret igual al secret
// SYNC_CRON_SECRET (mín. 16 caracteres), comparado en tiempo constante.

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

export function isCronRequest(req: Request): boolean {
  const secret = (Deno.env.get('SYNC_CRON_SECRET') ?? '').trim()
  const sent = req.headers.get('x-cron-secret') ?? ''
  return secret.length >= 16 && safeEqual(sent, secret)
}
```

- [ ] **Step 7: Usarlo en `sync-mileage/index.ts`**

En `supabase/functions/sync-mileage/index.ts`:
- Eliminar la función `safeEqual` completa, con su comentario.
- Agregar el import `import { isCronRequest } from '../_shared/cron.ts'`.
- Reemplazar estas tres líneas:

```ts
  const cronSecret = (Deno.env.get('SYNC_CRON_SECRET') ?? '').trim()
  const sentSecret = req.headers.get('x-cron-secret') ?? ''
  const fromCron = cronSecret.length >= 16 && safeEqual(sentSecret, cronSecret)
```

por esta:

```ts
  const fromCron = isCronRequest(req)
```

- [ ] **Step 8: Verificar tipos y tests**

Run:
```bash
cd supabase/functions
npx -y deno check sync-mileage/index.ts gps-status/index.ts create-user/index.ts
npx -y deno test --allow-net --allow-env _tests/
```
Expected: `Check …` sin errores y todos los tests en PASS.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared supabase/functions/sync-mileage supabase/functions/_tests
git commit -m "refactor(functions): withErrors, isCronRequest compartido y helpers de fecha"
```

---

### Task 4: Cálculo de avisos (`reminders.ts`)

**Files:**
- Create: `supabase/functions/_shared/reminders.ts`
- Create: `supabase/functions/_tests/reminders_test.ts`

- [ ] **Step 1: Tests (deben fallar)**

`supabase/functions/_tests/reminders_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert@1'
import { computeReminders, type ReminderVehicle } from '../_shared/reminders.ts'

const S = { maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30 }
const TODAY = '2026-09-26'

function v(p: Partial<ReminderVehicle> & { id: string }): ReminderVehicle {
  return {
    name: p.id, plate: null, active: true,
    next_maintenance_km: null, next_maintenance_date: null, insurance_expiry: null,
    ...p,
  }
}
const odo = (vehicle_id: string, odometer_km: number, has_data = true) => ({ vehicle_id, odometer_km, has_data })

Deno.test('mantenimiento por km: en el límite avisa, un km más no', () => {
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 12000 }), v({ id: 'b', next_maintenance_km: 12001 })],
    [odo('a', 10000), odo('b', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.remaining, i.overdue]), [['a', 'maintenance_km', 2000, false]])
})

Deno.test('mantenimiento por km: vencido cuando llega o se pasa', () => {
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 10000 }), v({ id: 'b', next_maintenance_km: 9500 })],
    [odo('a', 10000), odo('b', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.remaining, i.overdue]), [['b', -500, true], ['a', 0, true]])
})

Deno.test('mantenimiento por km: sin odómetro no avisa', () => {
  const items = computeReminders([v({ id: 'a', next_maintenance_km: 100 })], [odo('a', 0, false)], S, TODAY)
  assertEquals(items, [])
})

Deno.test('mantenimiento por fecha: límite, vencido y hoy', () => {
  const items = computeReminders([
    v({ id: 'lim', next_maintenance_date: '2026-10-11' }),   // 15 días
    v({ id: 'fuera', next_maintenance_date: '2026-10-12' }), // 16 días
    v({ id: 'hoy', next_maintenance_date: '2026-09-26' }),
    v({ id: 'venc', next_maintenance_date: '2026-09-20' }),
  ], [], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.remaining, i.overdue]), [
    ['venc', -6, true],
    ['hoy', 0, false],
    ['lim', 15, false],
  ])
})

Deno.test('seguro: vence hoy cuenta como vencido', () => {
  const items = computeReminders([
    v({ id: 'hoy', insurance_expiry: '2026-09-26' }),
    v({ id: 'lim', insurance_expiry: '2026-10-26' }),   // 30 días
    v({ id: 'fuera', insurance_expiry: '2026-10-27' }), // 31 días
  ], [], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.remaining, i.overdue]), [
    ['hoy', 'insurance', 0, true],
    ['lim', 'insurance', 30, false],
  ])
})

Deno.test('vehículos inactivos no avisan', () => {
  const items = computeReminders([v({ id: 'a', active: false, insurance_expiry: '2026-09-01' })], [], S, TODAY)
  assertEquals(items, [])
})

Deno.test('orden: vencidos primero; dentro de cada grupo, seguro, fecha, km y lo más urgente antes', () => {
  const items = computeReminders([
    v({ id: 'x', next_maintenance_km: 10500, insurance_expiry: '2026-10-10', next_maintenance_date: '2026-09-01' }),
    v({ id: 'y', insurance_expiry: '2026-09-25' }),
  ], [odo('x', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.overdue]), [
    ['y', 'insurance', true],
    ['x', 'maintenance_date', true],
    ['x', 'insurance', false],
    ['x', 'maintenance_km', false],
  ])
  assertEquals(items[3].dueKm, 10500)
  assertEquals(items[2].dueDate, '2026-10-10')
})
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/reminders_test.ts`
Expected: FAIL, porque no existe el módulo `../_shared/reminders.ts`.

- [ ] **Step 3: Implementar**

`supabase/functions/_shared/reminders.ts`:

```ts
// Cálculo puro de los avisos de vencimiento del día. Sin estado: se
// recalcula cada día, así que un aviso deja de aparecer en cuanto el admin
// actualiza el dato en la app.
import { daysBetween } from './time.ts'

export interface ReminderSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
}

export interface ReminderVehicle {
  id: string
  name: string
  plate: string | null
  active: boolean
  next_maintenance_km: number | string | null
  next_maintenance_date: string | null
  insurance_expiry: string | null
}

export interface OdometerRow {
  vehicle_id: string
  odometer_km: number | string
  has_data: boolean
}

export type ReminderKind = 'insurance' | 'maintenance_date' | 'maintenance_km'

export interface ReminderItem {
  vehicleId: string
  vehicleName: string
  plate: string | null
  kind: ReminderKind
  overdue: boolean
  // km o días que faltan; negativo si ya venció
  remaining: number
  dueDate?: string
  dueKm?: number
}

const KIND_ORDER: ReminderKind[] = ['insurance', 'maintenance_date', 'maintenance_km']

export function computeReminders(
  vehicles: ReminderVehicle[],
  odometers: OdometerRow[],
  settings: ReminderSettings,
  today: string,
): ReminderItem[] {
  const odoById = new Map(odometers.map(o => [o.vehicle_id, o]))
  const items: ReminderItem[] = []

  for (const v of vehicles) {
    if (!v.active) continue
    const base = { vehicleId: v.id, vehicleName: v.name, plate: v.plate }

    if (v.next_maintenance_km != null) {
      const odo = odoById.get(v.id)
      if (odo?.has_data) {
        const dueKm = Number(v.next_maintenance_km)
        const remaining = Math.round((dueKm - Number(odo.odometer_km)) * 100) / 100
        if (remaining <= settings.maintenance_km_threshold) {
          items.push({ ...base, kind: 'maintenance_km', remaining, overdue: remaining <= 0, dueKm })
        }
      }
    }

    if (v.next_maintenance_date) {
      const remaining = daysBetween(today, v.next_maintenance_date)
      if (remaining <= settings.maintenance_days_threshold) {
        items.push({ ...base, kind: 'maintenance_date', remaining, overdue: remaining < 0, dueDate: v.next_maintenance_date })
      }
    }

    if (v.insurance_expiry) {
      const remaining = daysBetween(today, v.insurance_expiry)
      if (remaining <= settings.insurance_days_threshold) {
        items.push({ ...base, kind: 'insurance', remaining, overdue: remaining <= 0, dueDate: v.insurance_expiry })
      }
    }
  }

  // Vencidos primero; dentro de cada grupo, por tipo y del más urgente al menos.
  return items.sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.remaining - b.remaining
    || a.vehicleName.localeCompare(b.vehicleName, 'es'))
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/reminders_test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/reminders.ts supabase/functions/_tests/reminders_test.ts
git commit -m "feat(functions): cálculo de avisos de vencimiento"
```

---

### Task 5: Armado del correo (`reminder_email.ts`)

**Files:**
- Create: `supabase/functions/_shared/reminder_email.ts`
- Create: `supabase/functions/_tests/reminder_email_test.ts`

- [ ] **Step 1: Tests (deben fallar)**

`supabase/functions/_tests/reminder_email_test.ts`:

```ts
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildReminderEmail, describeItem } from '../_shared/reminder_email.ts'
import type { ReminderItem } from '../_shared/reminders.ts'

const OPTS = { appName: 'Transportes Ejemplo', appUrl: 'https://flota.ejemplo.test/', today: '2026-09-26' }
const base = { vehicleId: '1', vehicleName: 'Pickup', plate: 'AB-12' }

Deno.test('describeItem: textos en español', () => {
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 1234.5, overdue: false, dueKm: 60000 }),
    'faltan 1.235 km (a los 60.000 km)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: -300, overdue: true, dueKm: 60000 }),
    'pasado por 300 km (tocaba a los 60.000 km)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 0, overdue: true, dueKm: 60000 }),
    'llegó a los 60.000 km')
  assertEquals(describeItem({ ...base, kind: 'insurance', remaining: 7, overdue: false, dueDate: '2026-10-03' }),
    'vence en 7 días (03/10/2026)')
  assertEquals(describeItem({ ...base, kind: 'insurance', remaining: 1, overdue: false, dueDate: '2026-09-27' }),
    'vence en 1 día (27/09/2026)')
  assertEquals(describeItem({ ...base, kind: 'insurance', remaining: 0, overdue: true, dueDate: '2026-09-26' }),
    'vence hoy (26/09/2026)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_date', remaining: -6, overdue: true, dueDate: '2026-09-20' }),
    'vencido hace 6 días (20/09/2026)')
})

Deno.test('correo con avisos: asunto, secciones, botón y texto plano', () => {
  const items: ReminderItem[] = [
    { ...base, kind: 'insurance', remaining: 0, overdue: true, dueDate: '2026-09-26' },
    { ...base, kind: 'maintenance_km', remaining: 800, overdue: false, dueKm: 60000 },
  ]
  const e = buildReminderEmail(items, OPTS)
  assertEquals(e.subject, 'Transportes Ejemplo: 2 vencimientos — 26/09/2026')
  assertStringIncludes(e.html, 'Vencidos')
  assertStringIncludes(e.html, 'Próximos')
  assertStringIncludes(e.html, 'Seguro')
  assertStringIncludes(e.html, 'Mantenimiento (km)')
  assertStringIncludes(e.html, 'href="https://flota.ejemplo.test/vehiculos"')
  assertStringIncludes(e.text, 'VENCIDOS')
  assertStringIncludes(e.text, '- Pickup (AB-12) · Seguro: vence hoy (26/09/2026)')
})

Deno.test('singular y sin avisos', () => {
  const one = buildReminderEmail([{ ...base, kind: 'insurance', remaining: 5, overdue: false, dueDate: '2026-10-01' }], OPTS)
  assertEquals(one.subject, 'Transportes Ejemplo: 1 vencimiento — 26/09/2026')
  assert(!one.html.includes('Vencidos'))
  const none = buildReminderEmail([], OPTS)
  assertEquals(none.subject, 'Transportes Ejemplo: sin vencimientos — 26/09/2026')
  assertStringIncludes(none.text, 'No hay vencimientos')
})

Deno.test('escapa HTML de los datos', () => {
  const e = buildReminderEmail([{ ...base, vehicleName: '<script>x</script>', kind: 'insurance', remaining: 1, overdue: false, dueDate: '2026-09-27' }], OPTS)
  assert(!e.html.includes('<script>'))
  assertStringIncludes(e.html, '&lt;script&gt;')
})
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/reminder_email_test.ts`
Expected: FAIL, porque no existe el módulo.

- [ ] **Step 3: Implementar**

`supabase/functions/_shared/reminder_email.ts`:

```ts
// Armado puro del correo de recordatorios: asunto, HTML (estilos inline,
// compatible con clientes de correo) y versión de texto plano.
import type { ReminderItem, ReminderKind } from './reminders.ts'

export interface EmailOptions {
  appName: string
  appUrl: string
  today: string // YYYY-MM-DD
}

export interface EmailContent {
  subject: string
  html: string
  text: string
}

const KIND_LABEL: Record<ReminderKind, string> = {
  insurance: 'Seguro',
  maintenance_date: 'Mantenimiento (fecha)',
  maintenance_km: 'Mantenimiento (km)',
}

// Entero con separador de miles "." (no depende del ICU del runtime).
function int(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

function date(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

function days(n: number): string {
  return `${n} día${n === 1 ? '' : 's'}`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function describeItem(item: ReminderItem): string {
  if (item.kind === 'maintenance_km') {
    const due = int(item.dueKm ?? 0)
    if (item.remaining > 0) return `faltan ${int(item.remaining)} km (a los ${due} km)`
    if (item.remaining === 0) return `llegó a los ${due} km`
    return `pasado por ${int(-item.remaining)} km (tocaba a los ${due} km)`
  }
  const d = date(item.dueDate ?? '')
  if (item.remaining > 0) return `vence en ${days(item.remaining)} (${d})`
  if (item.remaining === 0) return `vence hoy (${d})`
  return `vencido hace ${days(-item.remaining)} (${d})`
}

function vehicleLabel(item: ReminderItem): string {
  return item.plate ? `${item.vehicleName} (${item.plate})` : item.vehicleName
}

function section(title: string, color: string, items: ReminderItem[]): string {
  if (items.length === 0) return ''
  const rows = items.map(i => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#111827">${esc(vehicleLabel(i))}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#374151">${esc(KIND_LABEL[i.kind])}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${color}">${esc(describeItem(i))}</td>
      </tr>`).join('')
  return `
    <h2 style="margin:24px 0 8px;font-size:16px;color:${color}">${title} (${items.length})</h2>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px">${rows}
    </table>`
}

export function buildReminderEmail(items: ReminderItem[], opts: EmailOptions): EmailContent {
  const overdue = items.filter(i => i.overdue)
  const upcoming = items.filter(i => !i.overdue)
  const n = items.length
  const subject = n === 0
    ? `${opts.appName}: sin vencimientos — ${date(opts.today)}`
    : `${opts.appName}: ${n} vencimiento${n === 1 ? '' : 's'} — ${date(opts.today)}`
  const url = `${opts.appUrl.replace(/\/+$/, '')}/vehiculos`

  const body = n === 0
    ? '<p style="font-size:14px;color:#374151">No hay vencimientos para hoy.</p>'
    : section('Vencidos', '#dc2626', overdue) + section('Próximos', '#b45309', upcoming)

  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 4px;font-size:18px;color:#111827">${esc(opts.appName)}</h1>
    <p style="margin:0;font-size:13px;color:#6b7280">Vencimientos al ${date(opts.today)}</p>
    ${body}
    <p style="margin:24px 0">
      <a href="${esc(url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Abrir ${esc(opts.appName)}</a>
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af">Recibes este aviso porque eres administrador. Se repite cada día hasta que se actualice el dato en la app.</p>
  </div>
</body></html>`

  const lines = (title: string, list: ReminderItem[]) => list.length === 0 ? [] : [
    '', `${title} (${list.length})`,
    ...list.map(i => `- ${vehicleLabel(i)} · ${KIND_LABEL[i.kind]}: ${describeItem(i)}`),
  ]
  const text = [
    `${opts.appName} — vencimientos al ${date(opts.today)}`,
    ...(n === 0 ? ['', 'No hay vencimientos para hoy.'] : [...lines('VENCIDOS', overdue), ...lines('PRÓXIMOS', upcoming)]),
    '', `Abrir: ${url}`,
    '', 'Recibes este aviso porque eres administrador. Se repite cada día hasta que se actualice el dato en la app.',
  ].join('\n')

  return { subject, html, text }
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/reminder_email_test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/reminder_email.ts supabase/functions/_tests/reminder_email_test.ts
git commit -m "feat(functions): armado del correo de recordatorios"
```

---

### Task 6: Envío por Resend (`resend.ts`)

**Files:**
- Create: `supabase/functions/_shared/resend.ts`

- [ ] **Step 1: Implementar**

La cubre el test de flujo de la Task 7.

`supabase/functions/_shared/resend.ts`:

```ts
// Configuración y envío de correos con Resend (API HTTP). Las edge functions
// no permiten SMTP por los puertos 25/587.
import { HttpError } from './http.ts'

export interface EmailConfig {
  apiKey: string
  from: string
  appUrl: string
  appName: string
}

// Lee los secrets de correo. Lanza 500 con la lista de los que faltan.
export function emailConfig(): EmailConfig {
  const get = (k: string) => (Deno.env.get(k) ?? '').trim()
  const cfg = {
    apiKey: get('RESEND_API_KEY'),
    from: get('EMAIL_FROM'),
    appUrl: get('APP_URL'),
    appName: get('APP_NAME') || 'Flota Admin',
  }
  const missing = [
    !cfg.apiKey && 'RESEND_API_KEY',
    !cfg.from && 'EMAIL_FROM',
    !cfg.appUrl && 'APP_URL',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new HttpError(500, `Faltan secrets para enviar correos: ${missing.join(', ')}`)
  }
  return cfg
}

export interface OutgoingEmail {
  to: string[]
  subject: string
  html: string
  text: string
}

export async function sendEmail(cfg: EmailConfig, email: OutgoingEmail): Promise<void> {
  // RESEND_API_URL solo existe para apuntar a un servidor simulado en los tests.
  const url = Deno.env.get('RESEND_API_URL') || 'https://api.resend.com/emails'
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: email.to, subject: email.subject, html: email.html, text: email.text }),
  })
  if (!res.ok) {
    throw new Error(`Resend (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
}
```

- [ ] **Step 2: Verificar tipos**

Run: `cd supabase/functions && npx -y deno check _shared/resend.ts`
Expected: `Check _shared/resend.ts` sin errores.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/resend.ts
git commit -m "feat(functions): envío de correos con Resend"
```

---

### Task 7: Edge function `send-reminders`

**Files:**
- Create: `supabase/functions/send-reminders/handler.ts`
- Create: `supabase/functions/send-reminders/index.ts`
- Create: `supabase/functions/_tests/send_reminders_test.ts`
- Modify: `supabase/config.toml`

- [ ] **Step 1: Test de flujo contra un servidor simulado (debe fallar)**

`supabase/functions/_tests/send_reminders_test.ts`:

```ts
// Simula PostgREST, Auth y Resend en un servidor local y ejercita el handler
// en sus modos programado y de prueba.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'

const PORT = 54873
const BASE = `http://127.0.0.1:${PORT}`
Deno.env.set('SUPABASE_URL', BASE)
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_test' }))
Deno.env.set('APP_TIMEZONE', 'America/La_Paz') // UTC-4 fijo
Deno.env.set('SYNC_CRON_SECRET', 'secreto-de-prueba-123456')
Deno.env.set('RESEND_API_URL', `${BASE}/resend/emails`)
Deno.env.set('RESEND_API_KEY', 're_test')
Deno.env.set('EMAIL_FROM', 'Flota <avisos@ejemplo.test>')
Deno.env.set('APP_URL', 'https://flota.ejemplo.test')

const { createHandler } = await import('../send-reminders/handler.ts')
const { withErrors } = await import('../_shared/http.ts')

// ── Estado simulado ──────────────────────────────────────────
const state = {
  settings: { maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30, email_reminders_enabled: true },
  vehicles: [
    { id: 'v1', name: 'Pickup', plate: 'AB-1', active: true, next_maintenance_km: 10500, next_maintenance_date: null, insurance_expiry: '2026-09-20' },
    { id: 'v2', name: 'Sedán', plate: null, active: true, next_maintenance_km: null, next_maintenance_date: null, insurance_expiry: null },
  ],
  odometers: [{ vehicle_id: 'v1', odometer_km: 10000, has_data: true }],
  admins: [{ email: 'a1@ejemplo.test' }, { email: 'a2@ejemplo.test' }],
  log: new Map<string, Record<string, unknown>>(),
  emails: [] as Record<string, unknown>[],
  resendFails: false,
}

function resetState() {
  state.log.clear()
  state.emails = []
  state.resendFails = false
  state.settings.email_reminders_enabled = true
}

const server = Deno.serve({ port: PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  const single = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const one = (row: unknown) => single ? (row ? Response.json(row) : new Response(null, { status: 406 })) : Response.json(row ? [row] : [])

  if (url.pathname === '/resend/emails') {
    if (state.resendFails) return new Response('{"message":"dominio no verificado"}', { status: 403 })
    state.emails.push(await req.json())
    return Response.json({ id: 'email_1' })
  }
  if (url.pathname === '/auth/v1/user') {
    return req.headers.get('authorization') === 'Bearer jwt-admin'
      ? Response.json({ id: 'u-admin', email: 'yo@ejemplo.test' })
      : Response.json({ message: 'invalid' }, { status: 401 })
  }
  switch (url.pathname) {
    case '/rest/v1/fleet_settings': return one(state.settings)
    case '/rest/v1/vehicles': return Response.json(state.vehicles)
    case '/rest/v1/vehicle_odometer': return Response.json(state.odometers)
    case '/rest/v1/profiles':
      if (url.searchParams.get('id') === 'eq.u-admin') return one({ role: 'admin', active: true })
      return Response.json(state.admins)
    case '/rest/v1/rpc/flota_claim_reminder_day': {
      // Misma semántica que la función SQL: reclama si no existe o está en error.
      const { p_date } = await req.json()
      const row = state.log.get(p_date)
      if (row && row.status !== 'error') return Response.json(false)
      state.log.set(p_date, { local_date: p_date, status: 'sending' })
      return Response.json(true)
    }
    case '/rest/v1/reminder_log': {
      const body = await req.json()
      for (const row of Array.isArray(body) ? body : [body]) state.log.set(row.local_date, row)
      return new Response(null, { status: 201 })
    }
  }
  return new Response('not found', { status: 404 })
})

function cron() {
  return new Request('http://f/send-reminders', {
    method: 'POST', headers: { 'x-cron-secret': 'secreto-de-prueba-123456' }, body: '{}',
  })
}
const at = (iso: string) => withErrors(createHandler({ now: () => new Date(iso) }))
const SIETE = '2026-09-26T11:10:00Z' // 07:10 en UTC-4
const SEIS = '2026-09-26T10:10:00Z'  // 06:10 en UTC-4

Deno.test({ name: 'flujo de send-reminders', sanitizeOps: false, sanitizeResources: false, async fn(t) {
  try {
    await t.step('antes de las 7:00 no hace nada', async () => {
      resetState()
      const res = await (await at(SEIS)(cron())).json()
      assertEquals(res.skipped, 'hour')
      assertEquals(state.emails.length, 0)
    })

    await t.step('a las 7:10 envía un correo a todos los admins y lo registra', async () => {
      resetState()
      const res = await (await at(SIETE)(cron())).json()
      assertEquals(res.status, 'sent')
      assertEquals(res.items, 2)
      assertEquals(state.emails.length, 1)
      assertEquals(state.emails[0].to, ['a1@ejemplo.test', 'a2@ejemplo.test'])
      assertStringIncludes(String(state.emails[0].subject), '2 vencimientos — 26/09/2026')
      assertEquals(state.log.get('2026-09-26')?.status, 'sent')
    })

    await t.step('la siguiente hora no repite el envío', async () => {
      const res = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(res.skipped, 'already_sent')
      assertEquals(state.emails.length, 1)
    })

    await t.step('desactivado: registra y no envía', async () => {
      resetState()
      state.settings.email_reminders_enabled = false
      const res = await (await at(SIETE)(cron())).json()
      assertEquals(res.status, 'disabled')
      assertEquals(state.emails.length, 0)
      assertEquals(state.log.get('2026-09-26')?.status, 'disabled')
    })

    await t.step('sin avisos: registra y no envía', async () => {
      resetState()
      const saved = state.vehicles
      state.vehicles = [saved[1]]
      const res = await (await at(SIETE)(cron())).json()
      state.vehicles = saved
      assertEquals(res.status, 'nothing_to_send')
      assertEquals(state.emails.length, 0)
    })

    await t.step('error de Resend: registra error y reintenta la hora siguiente', async () => {
      resetState()
      state.resendFails = true
      const res = await at(SIETE)(cron())
      assertEquals(res.status, 502)
      assertEquals(state.log.get('2026-09-26')?.status, 'error')
      assertStringIncludes(String(state.log.get('2026-09-26')?.error), 'Resend (403)')
      state.resendFails = false
      const retry = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(retry.status, 'sent')
      assertEquals(state.log.get('2026-09-26')?.status, 'sent')
    })

    await t.step('secreto equivocado y sin sesión: 401', async () => {
      const req = new Request('http://f', { method: 'POST', headers: { 'x-cron-secret': 'otro' }, body: '{}' })
      assertEquals((await at(SIETE)(req)).status, 401)
    })

    await t.step('prueba de un admin: solo a quien la pide, a cualquier hora y sin registrar', async () => {
      resetState()
      const req = new Request('http://f', { method: 'POST', headers: { authorization: 'Bearer jwt-admin' }, body: '{"test":true}' })
      const res = await (await at(SEIS)(req)).json()
      assertEquals(res.status, 'sent')
      assertEquals(res.test, true)
      assertEquals(state.emails[0].to, ['yo@ejemplo.test'])
      assertEquals(state.log.size, 0)
    })
  } finally {
    await server.shutdown()
  }
} })
```

- [ ] **Step 2: Verificar que falla**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/send_reminders_test.ts`
Expected: FAIL, porque no existe el módulo `../send-reminders/handler.ts`.

- [ ] **Step 3: Implementar el handler**

`supabase/functions/send-reminders/handler.ts`:

```ts
// send-reminders: correo diario de vencimientos para los admins activos.
//
// Modo programado (pg_cron, header x-cron-secret): envía una sola vez por
// día, en la primera ejecución a partir de las 7:00 en APP_TIMEZONE. Si falla,
// la ejecución de la hora siguiente reintenta.
// Modo prueba (admin con sesión, body { test: true }): envía los avisos de hoy
// solo al admin que llama, a cualquier hora y sin registrar nada.
import { json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin } from '../_shared/supabase.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { appTimeZone, dateInTz, hourInTz } from '../_shared/time.ts'
import { computeReminders, type ReminderSettings } from '../_shared/reminders.ts'
import { buildReminderEmail } from '../_shared/reminder_email.ts'
import { emailConfig, sendEmail } from '../_shared/resend.ts'

const SEND_HOUR = 7

type Status = 'sent' | 'nothing_to_send' | 'disabled' | 'error'  // 'sending' lo pone flota_claim_reminder_day

interface Deps {
  now: () => Date
}

export function createHandler(deps: Deps = { now: () => new Date() }) {
  return async (req: Request): Promise<Response> => {
    const db = adminClient()
    const fromCron = isCronRequest(req)
    const caller = fromCron ? null : await requireAdmin(req, db)
    const body = await readJson<{ test?: boolean }>(req)
    const test = !fromCron && body.test === true
    if (!fromCron && !test) throw new HttpError(400, 'Usa { "test": true } para enviar un correo de prueba.')

    const tz = appTimeZone()
    const now = deps.now()
    const today = dateInTz(now, tz)

    const log = async (status: Status, recipients: string[], itemCount: number, error: string | null = null) => {
      const { error: e } = await db.from('reminder_log').upsert(
        { local_date: today, status, recipients, item_count: itemCount, error },
        { onConflict: 'local_date' },
      )
      if (e) console.error('send-reminders: no se pudo registrar el envío', e.message)
    }

    if (!test) {
      if (hourInTz(now, tz) < SEND_HOUR) return json({ skipped: 'hour', today })
      // Reclama el día de forma atómica: true solo si no existía o quedó en error.
      // Un 'sending' colgado cuenta como "posiblemente enviado" y no se reintenta.
      const { data: claimed, error: cErr } = await db.rpc('flota_claim_reminder_day', { p_date: today })
      if (cErr) throw new HttpError(500, `No se pudo reservar el envío del día: ${cErr.message}`)
      if (!claimed) return json({ skipped: 'already_sent', today })
    }

    const { data: settingsRow, error: sErr } = await db
      .from('fleet_settings')
      .select('maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled')
      .single()
    if (sErr || !settingsRow) throw new HttpError(500, `No se pudo leer la configuración: ${sErr?.message ?? 'sin fila'}`)

    if (!test && !settingsRow.email_reminders_enabled) {
      await log('disabled', [], 0)
      return json({ status: 'disabled', today })
    }

    const [{ data: vehicles, error: vErr }, { data: odometers, error: oErr }] = await Promise.all([
      db.from('vehicles').select('id, name, plate, active, next_maintenance_km, next_maintenance_date, insurance_expiry').eq('active', true),
      db.from('vehicle_odometer').select('vehicle_id, odometer_km, has_data'),
    ])
    if (vErr || oErr) throw new HttpError(500, (vErr ?? oErr)!.message)

    const items = computeReminders(vehicles ?? [], odometers ?? [], settingsRow as ReminderSettings, today)

    if (!test && items.length === 0) {
      await log('nothing_to_send', [], 0)
      return json({ status: 'nothing_to_send', today })
    }

    let recipients: string[]
    if (test) {
      recipients = caller?.user.email ? [caller.user.email] : []
    } else {
      const { data: admins } = await db.from('profiles').select('email').eq('role', 'admin').eq('active', true)
      recipients = (admins ?? []).map(a => a.email).filter(Boolean)
    }

    try {
      if (recipients.length === 0) throw new Error('No hay administradores activos con correo.')
      const cfg = emailConfig()
      const email = buildReminderEmail(items, { appName: cfg.appName, appUrl: cfg.appUrl, today })
      await sendEmail(cfg, { to: recipients, ...email })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!test) await log('error', recipients, items.length, message)
      throw new HttpError(502, message)
    }

    if (!test) await log('sent', recipients, items.length)
    return json({ status: 'sent', items: items.length, recipients: recipients.length, test, today })
  }
}
```

- [ ] **Step 4: El `index.ts`**

`supabase/functions/send-reminders/index.ts`:

```ts
import { serve } from '../_shared/http.ts'
import { createHandler } from './handler.ts'

serve(createHandler())
```

- [ ] **Step 5: Registrar la función en `config.toml`**

Agregar al final de `supabase/config.toml`:

```toml

[functions.send-reminders]
verify_jwt = false
```

- [ ] **Step 6: Verificar tipos y tests**

Run:
```bash
cd supabase/functions
npx -y deno check send-reminders/index.ts
npx -y deno test --allow-net --allow-env _tests/
```
Expected: `Check` sin errores, y todos los tests en PASS, incluidos los 8 pasos del flujo `send-reminders`.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/send-reminders supabase/functions/_tests/send_reminders_test.ts supabase/config.toml
git commit -m "feat(functions): send-reminders, correo diario de vencimientos"
```

---

### Task 8: Frontend — configuración compartida y odómetro desde la vista

**Files:**
- Create: `src/lib/settings.ts`
- Modify: `src/pages/vehicles/useOdometer.ts`

- [ ] **Step 1: `src/lib/settings.ts`**

```ts
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// Umbrales de aviso de la instalación (tabla fleet_settings, una sola fila).
// Los mismos valores usa la función send-reminders para los correos.
export interface FleetSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
  email_reminders_enabled: boolean
}

export const DEFAULT_SETTINGS: FleetSettings = {
  maintenance_km_threshold: 2000,
  maintenance_days_threshold: 15,
  insurance_days_threshold: 30,
  email_reminders_enabled: true,
}

const COLUMNS = 'maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled'

let cached: Promise<FleetSettings> | null = null

// Lee la configuración una vez por sesión de la página. `force` la vuelve a
// leer (después de guardar cambios). Ante un error devuelve los defaults sin
// cachearlos.
export function loadFleetSettings(force = false): Promise<FleetSettings> {
  if (!cached || force) {
    cached = Promise.resolve(supabase.from('fleet_settings').select(COLUMNS).single()).then(({ data, error }) => {
      if (error || !data) {
        cached = null
        return DEFAULT_SETTINGS
      }
      return { ...DEFAULT_SETTINGS, ...data } as FleetSettings
    })
  }
  return cached
}

export function useFleetSettings(): FleetSettings {
  const [settings, setSettings] = useState<FleetSettings>(DEFAULT_SETTINGS)
  useEffect(() => {
    let cancelled = false
    loadFleetSettings().then(s => { if (!cancelled) setSettings(s) })
    return () => { cancelled = true }
  }, [])
  return settings
}
```

- [ ] **Step 2: Reemplazar `src/pages/vehicles/useOdometer.ts` completo**

```ts
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Vehicle } from '@/types'

export interface Odometer {
  km: number
  // 'gps': odómetro base + km diarios del GPS.
  // 'manual': mayor valor entre el odómetro base y la última lectura de la bitácora.
  source: 'gps' | 'manual'
  hasData: boolean
  // true si el valor mostrado sale de una lectura de la bitácora (no del odómetro base).
  fromLog: boolean
}

// Lee el odómetro de la vista vehicle_odometer: la misma regla que usan los
// correos de recordatorio. `refreshKey` fuerza a releer.
export function useOdometer(vehicle: Vehicle, refreshKey: number): Odometer {
  const key = `${vehicle.id}:${refreshKey}`
  const [row, setRow] = useState<{ key: string; value: Odometer | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase
      .from('vehicle_odometer')
      .select('odometer_km, source, from_log, has_data')
      .eq('vehicle_id', vehicle.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setRow({
          key,
          value: data
            ? { km: Number(data.odometer_km), source: data.source, hasData: data.has_data, fromLog: data.from_log }
            : null,
        })
      })
    return () => { cancelled = true }
  }, [vehicle.id, key])

  if (row?.key === key && row.value) return row.value

  // Mientras carga: el odómetro base del vehículo.
  const base = Number(vehicle.odometer_offset) || 0
  return { km: base, source: vehicle.gps_device_id ? 'gps' : 'manual', hasData: base > 0, fromLog: false }
}
```

- [ ] **Step 3: Build y lint**

Run: `npm run lint && npm run build`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/lib/settings.ts src/pages/vehicles/useOdometer.ts
git commit -m "feat(web): configuración compartida y odómetro desde la vista"
```

---

### Task 9: Frontend — tarjeta con umbrales configurables y alerta de mantenimiento por fecha

**Files:**
- Modify: `src/pages/vehicles/VehicleCard.tsx`

- [ ] **Step 1: Import**

Debajo de `import { useOdometer } from './useOdometer'` agregar:

```ts
import { useFleetSettings } from '@/lib/settings'
```

- [ ] **Step 2: Reemplazar `MaintenanceBar` completo** (desde `function MaintenanceBar` hasta su `}` final)

```tsx
function MaintenanceBar({ vehicle, odometer, thresholdKm }: { vehicle: Vehicle; odometer: number; thresholdKm: number }) {
  if (vehicle.next_maintenance_km == null) return null

  const remaining = Number(vehicle.next_maintenance_km) - odometer
  const overdue = remaining <= 0
  const pct = overdue ? 0 : Math.min(100, (remaining / SERVICE_INTERVAL_KM) * 100)
  // Rojo en el último tercio del umbral (con 2.000 km: desde 667 km).
  const urgentKm = Math.ceil(thresholdKm / 3)

  const tone = overdue || remaining <= urgentKm
    ? { bar: 'bg-red-500', text: 'text-red-600', note: 'Mantenimiento urgente', Icon: AlertCircle as React.ElementType | null }
    : remaining <= thresholdKm
      ? { bar: 'bg-amber-400', text: 'text-amber-600', note: 'Próximo pronto', Icon: Wrench as React.ElementType | null }
      : { bar: 'bg-green-500', text: 'text-green-700', note: 'Al día', Icon: null }

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground font-[500]">
          <Wrench size={13} className="text-gray-400" />
          Próx. mantenimiento
        </div>
        <span className={`text-[14px] font-[730] tabular-nums ${tone.text}`}>
          {overdue ? `Vencido ${formatKm(Math.abs(remaining))}` : formatKm(remaining)}
        </span>
      </div>
      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${tone.bar}`} style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      {tone.Icon && (
        <div className={`flex items-center gap-1.5 text-[12px] font-[600] ${tone.text}`}>
          <tone.Icon size={12} />
          {tone.note}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Alerta de mantenimiento por fecha**

Agregar justo **después** de la función `daysUntil`:

```tsx
function MaintenanceDateRow({ vehicle, thresholdDays }: { vehicle: Vehicle; thresholdDays: number }) {
  if (!vehicle.next_maintenance_date) return null
  const daysLeft = daysUntil(vehicle.next_maintenance_date)
  if (daysLeft > thresholdDays) return null

  const tone = daysLeft < 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'
  const text = daysLeft < 0
    ? `Mantenimiento vencido hace ${-daysLeft} día${daysLeft === -1 ? '' : 's'}`
    : daysLeft === 0
      ? 'Mantenimiento programado para hoy'
      : `Mantenimiento en ${daysLeft} día${daysLeft === 1 ? '' : 's'}`

  return (
    <div className={`flex items-start gap-1.5 text-xs rounded px-2 py-1.5 ${tone}`}>
      <Wrench size={12} className="mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">{text}</p>
        <p>{formatDate(vehicle.next_maintenance_date)}</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Umbral configurable en `InsuranceRow`**

Cambiar la firma:

```tsx
function InsuranceRow({ vehicle }: { vehicle: Vehicle }) {
```

por:

```tsx
function InsuranceRow({ vehicle, thresholdDays }: { vehicle: Vehicle; thresholdDays: number }) {
```

Y dentro de `InsuranceRow`, reemplazar `daysLeft > 30` por `daysLeft > thresholdDays` (en la línea de `const tone = …`) y `daysLeft <= 30` por `daysLeft <= thresholdDays` (en la línea de `expiryText`).

- [ ] **Step 5: Usar la configuración en `VehicleCard`**

Dentro de `export default function VehicleCard(...)`, justo después de `const odometer = useOdometer(vehicle, refreshKey + logVersion)`, agregar:

```tsx
  const settings = useFleetSettings()
```

Reemplazar:

```tsx
            <MaintenanceBar vehicle={vehicle} odometer={odometer.km} />
            <InsuranceRow vehicle={vehicle} />
```

por:

```tsx
            <MaintenanceBar vehicle={vehicle} odometer={odometer.km} thresholdKm={settings.maintenance_km_threshold} />
            <MaintenanceDateRow vehicle={vehicle} thresholdDays={settings.maintenance_days_threshold} />
            <InsuranceRow vehicle={vehicle} thresholdDays={settings.insurance_days_threshold} />
```

- [ ] **Step 6: Build y lint**

Run: `npm run lint && npm run build`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add src/pages/vehicles/VehicleCard.tsx
git commit -m "feat(web): umbrales configurables y alerta de mantenimiento por fecha en la tarjeta"
```

---

### Task 10: Frontend — página Configuración

**Files:**
- Create: `src/pages/settings/SettingsPage.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: La página**

`src/pages/settings/SettingsPage.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Settings, Loader2, Mail } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { invokeFunction } from '@/lib/functions'
import { DEFAULT_SETTINGS, loadFleetSettings, type FleetSettings } from '@/lib/settings'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Fields = Record<'maintenance_km_threshold' | 'maintenance_days_threshold' | 'insurance_days_threshold', string>

function toFields(s: FleetSettings): Fields {
  return {
    maintenance_km_threshold: String(s.maintenance_km_threshold),
    maintenance_days_threshold: String(s.maintenance_days_threshold),
    insurance_days_threshold: String(s.insurance_days_threshold),
  }
}

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<FleetSettings | null>(null)
  const [fields, setFields] = useState<Fields>(toFields(DEFAULT_SETTINGS))
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    loadFleetSettings(true).then(s => {
      if (cancelled) return
      setLoaded(s)
      setFields(toFields(s))
      setEnabled(s.email_reminders_enabled)
    })
    return () => { cancelled = true }
  }, [])

  async function handleSave() {
    setMessage(null)
    const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Number(v)]))
    if (Object.values(values).some(n => !Number.isInteger(n) || n <= 0)) {
      setMessage({ ok: false, text: 'Los umbrales deben ser números enteros mayores que cero.' })
      return
    }
    setSaving(true)
    const { error } = await supabase
      .from('fleet_settings')
      .update({ ...values, email_reminders_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', true)
    setSaving(false)
    if (error) {
      setMessage({ ok: false, text: error.message })
      return
    }
    setLoaded(await loadFleetSettings(true))
    setMessage({ ok: true, text: 'Configuración guardada.' })
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await invokeFunction<{ items: number }>('send-reminders', { test: true })
      setTestResult({
        ok: true,
        text: res.items > 0
          ? `Correo enviado a tu dirección con ${res.items} vencimiento${res.items === 1 ? '' : 's'}.`
          : 'Correo enviado a tu dirección (hoy no hay vencimientos).',
      })
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const field = (key: keyof Fields, label: string, suffix: string, help: string) => (
    <div className="space-y-1">
      <Label htmlFor={key}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={key}
          type="number"
          min={1}
          step={1}
          className="w-32"
          value={fields[key]}
          onChange={e => setFields(f => ({ ...f, [key]: e.target.value }))}
        />
        <span className="text-sm text-muted-foreground">{suffix}</span>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  )

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Settings size={22} />
          Configuración
        </h1>
        <p className="text-sm text-muted-foreground">Umbrales de aviso y recordatorios por correo</p>
      </div>

      {!loaded ? (
        <p className="text-sm text-muted-foreground text-center py-12">Cargando...</p>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium">Avisar con anticipación</h2>
              {field('maintenance_km_threshold', 'Mantenimiento por kilometraje', 'km antes',
                'La tarjeta pasa a "Próximo pronto" y se incluye en el correo.')}
              {field('maintenance_days_threshold', 'Mantenimiento por fecha', 'días antes',
                'Para vehículos con fecha de próximo mantenimiento.')}
              {field('insurance_days_threshold', 'Vencimiento del seguro', 'días antes',
                'Alerta en la tarjeta y aviso por correo.')}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <h2 className="font-medium flex items-center gap-2"><Mail size={16} /> Recordatorios por correo</h2>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                />
                <span className="text-sm">
                  Enviar un resumen diario de vencimientos
                  <span className="block text-xs text-muted-foreground">
                    Se envía a las 7:00 a todos los administradores activos, y se repite cada día hasta que se actualice el dato.
                  </span>
                </span>
              </label>
              <div className="flex items-center gap-3 flex-wrap">
                <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
                  {testing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enviando...</> : 'Enviar correo de prueba'}
                </Button>
                {testResult && (
                  <p className={`text-sm ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>{testResult.text}</p>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-3">
            {message && <p className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-600'}`}>{message.text}</p>}
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</> : 'Guardar'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Ruta en `src/App.tsx`**

Debajo de `const UsersPage = lazy(() => import('./pages/users/UsersPage'))` agregar:

```tsx
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))
```

Y debajo del `<Route path="/usuarios" … />` completo agregar:

```tsx
            <Route
              path="/configuracion"
              element={
                <ProtectedRoute roles={['admin']}>
                  <SettingsPage />
                </ProtectedRoute>
              }
            />
```

- [ ] **Step 3: Menú en `src/components/Layout.tsx`**

Cambiar el import de iconos:

```tsx
import { Truck, Users, LogOut, Menu, KeyRound } from 'lucide-react'
```

por:

```tsx
import { Truck, Users, LogOut, Menu, KeyRound, Settings } from 'lucide-react'
```

Y en el array `nav`, debajo de la línea de `/usuarios`, agregar:

```tsx
    { to: '/configuracion', icon: Settings, label: 'Configuración', show: isAdmin },
```

- [ ] **Step 4: Build y lint**

Run: `npm run lint && npm run build`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/pages/settings src/App.tsx src/components/Layout.tsx
git commit -m "feat(web): página de configuración de umbrales y recordatorios"
```

---

### Task 11: Documentación y secrets de ejemplo

**Files:**
- Modify: `supabase/functions/.env.example`
- Modify: `docs/INSTALACION.md`
- Modify: `README.md`

- [ ] **Step 1: `.env.example` de las funciones**

Agregar al final de `supabase/functions/.env.example`:

```bash

# ── Recordatorios por correo (Resend) ────────────────────────
# Correo diario a los admins con mantenimientos y seguros por vencer.
# Crea una cuenta en https://resend.com, verifica tu dominio y genera una API key.
RESEND_API_KEY=
# Remitente, con un dominio verificado en Resend
EMAIL_FROM=Flota <avisos@tu-empresa.com>
# URL pública de la app (para el botón del correo)
APP_URL=https://flota.tu-empresa.com
# Opcional: nombre que aparece en el asunto (por defecto "Flota Admin")
# APP_NAME=
```

- [ ] **Step 2: Paso nuevo en `docs/INSTALACION.md`**

Insertar antes de la línea `## Lista de verificación`:

```markdown
## 9. Recordatorios por correo (opcional)

Todos los días, a partir de las 7:00 (hora de `APP_TIMEZONE`), Flota Admin envía a los administradores activos un resumen con:

- los mantenimientos próximos o vencidos, por kilometraje y por fecha;
- los seguros por vencer o vencidos.

El aviso se repite cada día hasta que se actualiza el dato en la app. Si no hay nada que avisar, no se envía correo.

1. Crea una cuenta en [Resend](https://resend.com):
   - *Domains → Add domain*: agrega los registros DNS que indica y espera a que el dominio quede **verificado**.
   - *API Keys → Create*: genera una key con permiso de envío.
2. Completa en `supabase/functions/.env` `RESEND_API_KEY`, `EMAIL_FROM` (con el dominio verificado) y `APP_URL`, y súbelos:

   ```bash
   npx supabase@latest secrets set --env-file supabase/functions/.env
   ```

3. En la app, entra a **Configuración**:
   - ajusta los umbrales, si quieres;
   - pulsa **Enviar correo de prueba**: te llega a tu dirección con los vencimientos de hoy.

El job `flota-recordatorios` usa los mismos secretos de Vault que el cron de kilometraje (paso 8), así que no hace falta nada más. Para revisar los envíos:

```sql
select local_date, status, item_count, recipients, error
from public.reminder_log
order by local_date desc
limit 10;
```

```

En la tabla "Lista de verificación", agregar la línea:

```markdown
- [ ] (Correo) El correo de prueba llega desde **Configuración** (paso 9).
```

En la tabla "Problemas frecuentes", agregar:

```markdown
| **"Faltan secrets para enviar correos"** | Falta `RESEND_API_KEY`, `EMAIL_FROM` o `APP_URL` (paso 9). |
| **"Resend (403)"** al enviar la prueba | El dominio de `EMAIL_FROM` no está verificado en Resend. |
```

- [ ] **Step 3: README**

En `README.md`, dentro de la lista de funcionalidades, debajo del ítem del seguro, agregar:

```markdown
- **Recordatorios por correo:** resumen diario a los administradores con mantenimientos y seguros próximos o vencidos, hasta que se actualice el dato. Los umbrales se configuran desde la app.
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/.env.example docs/INSTALACION.md README.md
git commit -m "docs: recordatorios por correo"
```

---

### Task 12: Verificación en el proyecto de prueba

Requiere que el usuario provea su `RESEND_API_KEY` y un `EMAIL_FROM` con un dominio verificado. En la cuenta nueva de Resend también sirve `onboarding@resend.dev`, pero solo envía al correo del dueño de esa cuenta.

- [ ] **Step 1: Suite completa en local**

```bash
npm run lint
npm run build
npm run test:db
cd supabase/functions
npx -y deno test --allow-net --allow-env _tests/
```

Expected: todo sin errores ni fallos.

- [ ] **Step 2: Migración y deploy**

```bash
cat supabase/.temp/project-ref                   # debe ser oklpfxskdujpaqxnwvbf
npx -y supabase@latest db push
npx -y supabase@latest functions deploy --use-api
```

Expected:
- `db push` aplica `20260926000600_recordatorios.sql`;
- el deploy incluye `send-reminders`, y `sync-mileage` se redespliega con el refactor.

- [ ] **Step 3: Secrets de correo**

El usuario completa `RESEND_API_KEY`, `EMAIL_FROM` y `APP_URL` (para la prueba local, `http://localhost:4173`) en `supabase/functions/.env`, y se suben:

```bash
npx -y supabase@latest secrets set --env-file supabase/functions/.env
```

- [ ] **Step 4: Prueba desde la app**

1. Levantar la vista previa (`npm run build`, generar `dist/env-config.js` y `vite preview`).
2. Entrar como admin → **Configuración** → **Enviar correo de prueba**.
3. Verificar que llegó a la casilla del usuario, con los 4 vehículos demo:
   - seguros vencido y por vencer;
   - mantenimiento por km próximo;
   - mantenimiento por fecha del Sedán, solo si queda dentro de los 15 días.

- [ ] **Step 5: Envío programado forzado**

En SQL, como superusuario del proyecto de prueba:

```sql
select public.flota_request_reminders();
-- unos segundos después
select status_code, content from net._http_response order by created desc limit 1;
select local_date, status, item_count, recipients from public.reminder_log;
```

Expected:
- si la hora local es ≥ 7:00: `status_code 200`, `"status":"sent"` y una fila `sent` en `reminder_log`;
- una segunda llamada responde `"skipped":"already_sent"`.

- [ ] **Step 6: Tarjetas**

Revisar en la app:
- la alerta nueva de mantenimiento por fecha;
- que cambiar un umbral en Configuración cambie los colores y alertas al recargar Vehículos.

- [ ] **Step 7: Push**

```bash
git push origin main
```
