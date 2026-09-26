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
