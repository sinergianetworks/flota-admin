// Aplica todas las migraciones sobre PGlite (Postgres en memoria) con stubs
// mínimos de Supabase y prueba la RLS. Uso: npm run test:db
//
// Limitaciones del harness:
// - Corre como superusuario de PGlite. En Supabase, el rol "postgres" NO es
//   superusuario, así que los privilegios reales sobre Vault y pg_net (y
//   cualquier cosa que dependa de RLS de superusuario) no se prueban aquí.
// - auth.uid() es un stub que lee el GUC request.jwt.claim.sub (as() lo fija
//   con set_config), no el JWT real de Supabase Auth.
// - Las sentencias "create extension ..." de las migraciones se eliminan
//   con una regex antes de aplicarlas, porque PGlite no las soporta.
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
r = await as(A, `delete from public.fleet_settings`)
ok('nadie borra la configuración', !!r.error || r.affected === 0)
r = await as(A, `select count(*) as n from public.fleet_settings`)
ok('la fila de configuración sigue existiendo', Number(r.rows?.[0]?.n) === 1, JSON.stringify(r))
r = await as(null, `select * from public.fleet_settings`, [], 'anon')
ok('anon sin acceso a fleet_settings', !!r.error)
r = await as(A, `update public.profiles set active = false where id = $1 returning active`, [D2])
ok('admin desactiva al conductor', r.rows?.[0]?.active === false, JSON.stringify(r))
r = await as(D2, `select * from public.fleet_settings`)
ok('conductor desactivado no lee la configuración', !r.error && r.rows.length === 0, JSON.stringify(r))

console.log('\nreminder_log')
r = await as(A, `select * from public.reminder_log`)
ok('admin no accede a reminder_log (solo service role)', !!r.error)
r = await as(null, `insert into public.reminder_log (local_date, status) values ('2026-09-26', 'sent')`, [], 'service_role')
ok('service role registra envíos', !r.error, r.error)
r = await as(null, `insert into public.reminder_log (local_date, status) values ('2026-09-26', 'sent')`, [], 'service_role')
ok('un solo registro por día', !!r.error)

console.log('\nflota_claim_notification')
r = await as(null, `select public.flota_claim_notification('daily', '2026-09-10') as c`, [], 'service_role')
ok('primer claim diario → true', r.rows?.[0]?.c === true, JSON.stringify(r))
r = await as(null, `select public.flota_claim_notification('daily', '2026-09-10') as c`, [], 'service_role')
ok('segundo claim diario → false', r.rows?.[0]?.c === false, JSON.stringify(r))
r = await as(null, `select public.flota_claim_notification('weekly', '2026-09-10') as c`, [], 'service_role')
ok('el semanal del mismo día es independiente → true', r.rows?.[0]?.c === true, JSON.stringify(r))
await db.query(`update public.reminder_log set status = 'error' where kind = 'daily' and local_date = '2026-09-10'`)
r = await as(null, `select public.flota_claim_notification('daily', '2026-09-10') as c`, [], 'service_role')
ok('claim sobre error → true', r.rows?.[0]?.c === true)
r = await db.query(`select status from public.reminder_log where kind = 'daily' and local_date = '2026-09-10'`)
ok('queda en sending', r.rows[0]?.status === 'sending')
await db.query(`update public.reminder_log set status = 'sent' where kind = 'weekly' and local_date = '2026-09-10'`)
r = await as(null, `select public.flota_claim_notification('weekly', '2026-09-10') as c`, [], 'service_role')
ok('claim sobre sent → false', r.rows?.[0]?.c === false)
r = await as(null, `select public.flota_claim_notification('mensual', '2026-09-10') as c`, [], 'service_role')
ok('tipo inválido falla', !!r.error)
r = await as(A, `select public.flota_claim_notification('daily', '2026-09-11')`)
ok('authenticated no puede reservar', !!r.error)
r = await db.query(`select count(*)::int n from pg_proc where proname = 'flota_claim_reminder_day'`)
ok('la función vieja ya no existe', r.rows[0].n === 0)

console.log('\nvehicle_odometer')
await as(A, `insert into public.vehicle_daily_mileage (vehicle_id, date, km) values ($1, '2026-09-24', 10.5), ($1, '2026-09-25', 20)`, [V.GPS])
await as(A, `insert into public.vehicle_log (vehicle_id, type, description, odometer_km, date) values
  ($1, 'fuel', 'a', 700, '2026-09-20'), ($1, 'fuel', 'b', 650, '2026-09-22')`, [V.Manual])
r = await as(A, `insert into public.vehicles (name, gps_provider, gps_device_id, odometer_offset) values
  ('GPS0', 'tracksolid', '222', 0), ('ManualBajo', null, null, 500), ('ManualMismaFecha', null, null, 0)
  returning id, name`)
for (const x of r.rows) V[x.name] = x.id
await as(A, `insert into public.vehicle_log (vehicle_id, type, description, odometer_km, date) values
  ($1, 'fuel', 'menor a la base', 300, '2026-09-20')`, [V.ManualBajo])
await as(A, `insert into public.vehicle_log (vehicle_id, type, description, odometer_km, date, created_at) values
  ($1, 'fuel', 'primera', 400, '2026-09-23', '2026-09-23T08:00:00Z'),
  ($1, 'fuel', 'segunda (más reciente)', 550, '2026-09-23', '2026-09-23T09:00:00Z')`, [V.ManualMismaFecha])
r = await as(A, `select v.name, o.odometer_km::float as km, o.source, o.from_log, o.has_data
  from public.vehicle_odometer o join public.vehicles v on v.id = o.vehicle_id order by v.name`)
const od = Object.fromEntries((r.rows ?? []).map(x => [x.name, x]))
ok('GPS = base + Σ km diarios', od.GPS?.km === 1030.5 && od.GPS?.source === 'gps' && od.GPS?.has_data === true, JSON.stringify(od.GPS))
ok('manual = máx(base, última lectura por fecha)', od.Manual?.km === 650 && od.Manual?.source === 'manual' && od.Manual?.from_log === true, JSON.stringify(od.Manual))
ok('sin datos: has_data = false', od.Libre?.km === 0 && od.Libre?.has_data === false, JSON.stringify(od.Libre))
ok('GPS con base 0 y sin km diarios: has_data = false', od.GPS0?.km === 0 && od.GPS0?.source === 'gps' && od.GPS0?.has_data === false, JSON.stringify(od.GPS0))
ok('manual con lectura menor que la base: from_log = false y km = base', od.ManualBajo?.km === 500 && od.ManualBajo?.source === 'manual' && od.ManualBajo?.from_log === false, JSON.stringify(od.ManualBajo))
ok('misma fecha: gana la de created_at más reciente', od.ManualMismaFecha?.km === 550, JSON.stringify(od.ManualMismaFecha))
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
r = await as(null, `select public.flota_request_reminders()`, [], 'anon')
ok('anon no puede dispararlo', !!r.error)

console.log('\nreporte semanal: configuración')
r = await as(A, `select notification_emails, weekly_report_enabled, weekly_report_day from public.fleet_settings`)
ok('defaults: lista vacía, semanal activo, lunes', JSON.stringify(r.rows?.[0]) === JSON.stringify({ notification_emails: [], weekly_report_enabled: true, weekly_report_day: 1 }), JSON.stringify(r))
r = await as(A, `update public.fleet_settings set notification_emails = array['flota@empresa.test', 'jefe@empresa.test'] returning notification_emails`)
ok('admin guarda destinatarios válidos', r.rows?.[0]?.notification_emails?.length === 2, JSON.stringify(r))
r = await as(A, `update public.fleet_settings set notification_emails = array['no-es-correo']`)
ok('correo inválido se rechaza', !!r.error)
r = await as(A, `update public.fleet_settings set notification_emails = array['a@b.co', null]`)
ok('un elemento null se rechaza', !!r.error)
r = await as(A, `update public.fleet_settings set notification_emails = (select array_agg('u' || g || '@e.test') from generate_series(1, 51) g)`)
ok('más de 50 destinatarios se rechaza', !!r.error)
r = await as(A, `update public.fleet_settings set notification_emails = (select array_agg(array['u' || g || 'a@e.test', 'u' || g || 'b@e.test']) from generate_series(1, 26) g)`)
ok('array de 2 dimensiones con más de 50 correos se rechaza', !!r.error)
r = await as(A, `update public.fleet_settings set weekly_report_day = 8`)
ok('día 8 se rechaza', !!r.error)
r = await as(A, `update public.fleet_settings set weekly_report_day = 5, notification_emails = '{}' returning weekly_report_day`)
ok('admin cambia el día', r.rows?.[0]?.weekly_report_day === 5)
r = await as(D1, `update public.fleet_settings set weekly_report_enabled = false`)
ok('conductor no edita', !r.error && r.affected === 0)

console.log('\ncron semanal')
r = await db.query(`select schedule from cron.job where jobname = 'flota-reporte-semanal'`)
ok('job semanal cada hora al minuto 15', r.rows[0]?.schedule === '15 * * * *')
await db.exec(`delete from vault.decrypted_secrets`)
r = await db.query(`select public.flota_request_weekly_report() as id`)
ok('sin secretos no llama', r.rows[0].id === null)
await db.exec(`insert into vault.decrypted_secrets values ('flota_project_url', 'https://x.supabase.co'), ('flota_sync_secret', 's3cr3t')`)
r = await db.query(`select public.flota_request_weekly_report() as id`)
const wcall = (await db.query(`select url from net.calls order by id desc limit 1`)).rows[0]
ok('con secretos llama a send-weekly-report', r.rows[0].id !== null && wcall.url === 'https://x.supabase.co/functions/v1/send-weekly-report', JSON.stringify(wcall))
r = await as(A, `select public.flota_request_weekly_report()`)
ok('authenticated no puede dispararlo', !!r.error)
r = await as(null, `select public.flota_request_weekly_report()`, [], 'anon')
ok('anon no puede dispararlo', !!r.error)

console.log(`\n${pass} OK · ${fail} fallos`)
process.exit(fail ? 1 : 0)
