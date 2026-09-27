# Reporte semanal, alerta diaria de mantenimiento y destinatarios — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tres cambios sobre los recordatorios por correo:
- la alerta diaria pasa a ser solo de mantenimiento, con días estimados;
- se agrega un reporte semanal de todos los vehículos, en un día configurable;
- los destinatarios se configuran en la app, y si la lista está vacía se usan los admins.

**Architecture:**
- **Base de datos:** una migración suma columnas a `fleet_settings`, el tipo de envío (`kind`) en `reminder_log`, la reserva por tipo y el job semanal.
- **Módulo compartido `_shared/notify.ts`:** concentra la máquina de estados del envío (reserva, destinatarios, Resend, registro).
- **Módulos de contenido:** `reminders.ts`, `reminder_email.ts`, `weekly_report.ts` y `weekly_email.ts` son puros y testeables. `email_format.ts` tiene los helpers de formato comunes.
- **Funciones:** `send-reminders` se refactoriza sobre `notify.ts`, y `send-weekly-report` es nueva.
- **Frontend:** la página de Configuración se reorganiza.

**Tech Stack:** Postgres/Supabase (RLS, pg_cron, pg_net, Vault), Deno edge functions, Resend, React + Vite, PGlite para los tests de SQL.

**Spec:** `docs/superpowers/specs/2026-09-27-reporte-semanal-design.md`

**Convenciones:**
- Rama `feature/reporte-semanal`. Hacer commit al terminar cada tarea y no hacer push.
- Todo el texto en español.
- Deno con `npx -y deno …` desde `supabase/functions/`. Borrar cualquier `deno.lock` que aparezca.
- El CLI de Supabase con `npx -y supabase@latest`.
- **No** tocar el proyecto Supabase de Campo (`pxjqxhajvpwofaaolhop`). El de prueba es `oklpfxskdujpaqxnwvbf`, y solo se usa en la Task 11.
- Los mensajes de commit terminan con una línea en blanco y `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Nota respecto de la spec:** el cálculo de las alertas de seguro (`computeInsuranceAlerts`) y el orden (`sortReminders`) se implementan en `_shared/reminders.ts` y no en `weekly_report.ts`, para que los dos correos compartan una sola implementación.

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `supabase/migrations/20260927000700_reporte_semanal.sql` | Crear | Columnas nuevas, `kind`, reserva por tipo, job semanal |
| `supabase/tests/db.test.mjs` | Modificar | Tests de la migración |
| `supabase/functions/_shared/time.ts` | Modificar | `isoWeekday` |
| `supabase/functions/_shared/reminders.ts` | Modificar | Solo mantenimiento en `computeReminders`, más `averageKmPerDay`, `computeInsuranceAlerts` y `sortReminders` |
| `supabase/functions/_shared/email_format.ts` | Crear | Formato común de los correos (números, fechas, escape, descripción de avisos, tabla de alertas) |
| `supabase/functions/_shared/reminder_email.ts` | Modificar | Correo diario: asunto nuevo, estimación, pie |
| `supabase/functions/_shared/notify.ts` | Crear | Configuración, destinatarios y `deliver` (reserva, envío, registro) |
| `supabase/functions/send-reminders/handler.ts` | Reescribir | Usa `notify.ts` y las estimaciones |
| `supabase/functions/_shared/weekly_report.ts` | Crear | Cálculo puro del reporte |
| `supabase/functions/_shared/weekly_email.ts` | Crear | Correo semanal |
| `supabase/functions/send-weekly-report/{handler,index}.ts` | Crear | Función nueva |
| `supabase/functions/_tests/*` | Crear/Modificar | Tests |
| `supabase/config.toml` | Modificar | `[functions.send-weekly-report]` |
| `src/lib/settings.ts`, `src/pages/settings/SettingsPage.tsx` | Modificar | Campos nuevos y página reorganizada |
| `docs/INSTALACION.md`, `README.md` | Modificar | Documentación |

---

### Task 1: Migración (columnas, `kind`, reserva por tipo, job semanal)

**Files:**
- Create: `supabase/migrations/20260927000700_reporte_semanal.sql`
- Modify: `supabase/tests/db.test.mjs`

- [ ] **Step 1: Tests que deben fallar**

En `supabase/tests/db.test.mjs`:

a) Reemplazar las pruebas de `flota_claim_reminder_day`, que ya no existirá, por pruebas de `flota_claim_notification`. Buscar con `grep -n "flota_claim_reminder_day" supabase/tests/db.test.mjs` y reemplazar ese bloque completo por:

```js
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
```

Si alguna prueba anterior inserta en `reminder_log` usando `local_date` como única clave de conflicto, ajústala para que tenga en cuenta `kind`. Hoy el unique pasa a ser `(kind, local_date)`, y la prueba "un solo registro por día" debe insertar dos veces la misma combinación **con el mismo `kind`**.

b) Antes de `console.log(\`\n${pass} OK · ${fail} fallos\`)`, agregar:

```js
console.log('\nreporte semanal: configuración')
r = await as(A, `select notification_emails, weekly_report_enabled, weekly_report_day from public.fleet_settings`)
ok('defaults: lista vacía, semanal activo, lunes', JSON.stringify(r.rows?.[0]) === JSON.stringify({ notification_emails: [], weekly_report_enabled: true, weekly_report_day: 1 }), JSON.stringify(r))
r = await as(A, `update public.fleet_settings set notification_emails = array['flota@empresa.test', 'jefe@empresa.test'] returning notification_emails`)
ok('admin guarda destinatarios válidos', r.rows?.[0]?.notification_emails?.length === 2, JSON.stringify(r))
r = await as(A, `update public.fleet_settings set notification_emails = array['no-es-correo']`)
ok('correo inválido se rechaza', !!r.error)
r = await as(A, `update public.fleet_settings set notification_emails = (select array_agg('u' || g || '@e.test') from generate_series(1, 51) g)`)
ok('más de 50 destinatarios se rechaza', !!r.error)
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
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npm run test:db`
Expected: fallan las pruebas nuevas (función o columnas inexistentes).

- [ ] **Step 3: La migración**

`supabase/migrations/20260927000700_reporte_semanal.sql`:

```sql
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
```

- [ ] **Step 4: Verificar**

Run: `npm run test:db`
Expected: todas las migraciones OK y `… OK · 0 fallos`. Si el nombre de la constraint única de `local_date` en la migración 0600 no es `reminder_log_local_date_key`, verificarlo con `grep -n "local_date" supabase/migrations/20260926000600_recordatorios.sql` y ajustar el `drop constraint`. Una columna `unique` sin nombre genera `<tabla>_<columna>_key`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260927000700_reporte_semanal.sql supabase/tests/db.test.mjs
git commit -m "feat(db): destinatarios, reporte semanal y reserva de envío por tipo"
```

---

### Task 2: `isoWeekday` y cálculo de mantenimiento con estimación (`reminders.ts`)

**Files:**
- Modify: `supabase/functions/_shared/time.ts`, `supabase/functions/_shared/reminders.ts`
- Modify: `supabase/functions/_tests/time_test.ts`, `supabase/functions/_tests/reminders_test.ts`

- [ ] **Step 1: Tests (deben fallar)**

Agregar a `_tests/time_test.ts` (sumar `isoWeekday` al import):

```ts
Deno.test('isoWeekday: 1 = lunes … 7 = domingo', () => {
  assertEquals(isoWeekday('2026-09-28'), 1) // lunes
  assertEquals(isoWeekday('2026-10-02'), 5) // viernes
  assertEquals(isoWeekday('2026-09-27'), 7) // domingo
})
```

En `_tests/reminders_test.ts`:
- Sumar al import `averageKmPerDay, computeInsuranceAlerts, sortReminders`.
- **Eliminar** los tests del seguro de `computeReminders`, porque el seguro ya no se calcula ahí: "seguro: vence hoy cuenta como vencido" y la parte de seguro del test de orden.
- Reemplazar el test de orden por el primero de los siguientes y agregar el resto:

```ts
Deno.test('computeReminders ya no incluye el seguro', () => {
  const items = computeReminders([v({ id: 'a', insurance_expiry: '2026-09-01' })], [], S, TODAY)
  assertEquals(items, [])
})

Deno.test('orden: vencidos primero; dentro de cada grupo, fecha antes que km y lo más urgente antes', () => {
  const items = computeReminders([
    v({ id: 'x', next_maintenance_km: 10500, next_maintenance_date: '2026-09-01' }),
    v({ id: 'y', next_maintenance_km: 9900 }),
  ], [odo('x', 10000), odo('y', 10000)], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.overdue]), [
    ['x', 'maintenance_date', true],
    ['y', 'maintenance_km', true],
    ['x', 'maintenance_km', false],
  ])
})

Deno.test('computeInsuranceAlerts: vence hoy = vencido, umbral inclusivo', () => {
  const items = computeInsuranceAlerts([
    v({ id: 'hoy', insurance_expiry: '2026-09-26' }),
    v({ id: 'lim', insurance_expiry: '2026-10-26' }),
    v({ id: 'fuera', insurance_expiry: '2026-10-27' }),
    v({ id: 'inactivo', active: false, insurance_expiry: '2026-09-01' }),
  ], S, TODAY)
  assertEquals(items.map(i => [i.vehicleId, i.kind, i.remaining, i.overdue]), [
    ['hoy', 'insurance', 0, true],
    ['lim', 'insurance', 30, false],
  ])
})

Deno.test('sortReminders: seguro antes que mantenimiento dentro del mismo grupo', () => {
  const ins = computeInsuranceAlerts([v({ id: 's', insurance_expiry: '2026-09-20' })], S, TODAY)
  const mnt = computeReminders([v({ id: 'm', next_maintenance_date: '2026-09-20' })], [], S, TODAY)
  assertEquals(sortReminders([...mnt, ...ins]).map(i => i.kind), ['insurance', 'maintenance_date'])
})

Deno.test('averageKmPerDay: 28 días, los días sin registro cuentan como 0', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(12 + i).padStart(2, '0')}`, km: 56 }))
  assertEquals(averageKmPerDay(rows, TODAY), 28) // 14 × 56 / 28
})

Deno.test('averageKmPerDay: menos de 7 días con registro → null; promedio 0 → null; ignora fuera de rango', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ date: `2026-09-${String(20 + i).padStart(2, '0')}`, km: 100 }))
  assertEquals(averageKmPerDay(six, TODAY), null)
  const zeros = Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, '0')}`, km: 0 }))
  assertEquals(averageKmPerDay(zeros, TODAY), null)
  const withToday = [...Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-${String(19 + i).padStart(2, '0')}`, km: 28 })), { date: TODAY, km: 9999 }]
  assertEquals(averageKmPerDay(withToday, TODAY), 7) // 7 × 28 / 28; el día de hoy no cuenta
})

Deno.test('estimatedDays en mantenimiento por km (redondeo hacia arriba), no en vencidos', () => {
  const avg = new Map([['a', 100], ['b', 100]])
  const items = computeReminders(
    [v({ id: 'a', next_maintenance_km: 10750 }), v({ id: 'b', next_maintenance_km: 9900 }), v({ id: 'c', next_maintenance_km: 10500 })],
    [odo('a', 10000), odo('b', 10000), odo('c', 10000)], S, TODAY, avg)
  const byId = Object.fromEntries(items.map(i => [i.vehicleId, i]))
  assertEquals(byId.a.estimatedDays, 8)       // 750 / 100 → 7,5 → 8
  assertEquals(byId.b.estimatedDays, undefined) // vencido
  assertEquals(byId.c.estimatedDays, undefined) // sin promedio
})
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/time_test.ts _tests/reminders_test.ts`
Expected: FAIL (exports inexistentes).

- [ ] **Step 3: Implementación**

En `_shared/time.ts` agregar al final:

```ts
// Día de la semana ISO de una fecha YYYY-MM-DD: 1 = lunes … 7 = domingo.
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay()
  return d === 0 ? 7 : d
}
```

En `_shared/reminders.ts`:
- Import: `import { addDays, daysBetween } from './time.ts'`.
- Agregar `estimatedDays?: number` a `ReminderItem`, justo después de `dueKm?: number`, con el comentario `// días estimados hasta el mantenimiento por km (ritmo de los últimos 28 días)`.
- Agregar `gps_device_id?: string | null` a `ReminderVehicle` (opcional).
- Reemplazar la función `computeReminders` completa por:

```ts
const AVG_WINDOW_DAYS = 28
const MIN_DAYS_WITH_DATA = 7

// Promedio de km por día de los últimos 28 días completos (hoy excluido).
// Los días sin registro cuentan como 0 (el vehículo no se movió). Devuelve
// null si hay menos de 7 días con registro o si el promedio no es positivo.
export function averageKmPerDay(rows: { date: string; km: number | string }[], today: string): number | null {
  const from = addDays(today, -AVG_WINDOW_DAYS)
  const inRange = rows.filter(r => r.date >= from && r.date < today)
  const days = new Set(inRange.map(r => r.date))
  if (days.size < MIN_DAYS_WITH_DATA) return null
  const avg = inRange.reduce((s, r) => s + Number(r.km), 0) / AVG_WINDOW_DAYS
  return avg > 0 ? avg : null
}

// Avisos de mantenimiento (por km y por fecha) de los vehículos activos.
// `avgKmPerDay` (opcional): promedio por vehículo para estimar los días.
export function computeReminders(
  vehicles: ReminderVehicle[],
  odometers: OdometerRow[],
  settings: ReminderSettings,
  today: string,
  avgKmPerDay: Map<string, number> = new Map(),
): ReminderItem[] {
  const odoById = new Map(odometers.map(o => [o.vehicle_id, o]))
  const items: ReminderItem[] = []

  for (const v of vehicles) {
    if (!v.active) continue
    const base = { vehicleId: v.id, vehicleName: v.name, plate: v.plate }

    if (v.next_maintenance_km != null) {
      const odo = odoById.get(v.id)
      const dueKm = Number(v.next_maintenance_km)
      if (odo?.has_data && Number.isFinite(dueKm) && dueKm > 0) {
        const remaining = Math.round(dueKm - Number(odo.odometer_km))
        if (remaining <= settings.maintenance_km_threshold) {
          const overdue = remaining <= 0
          const avg = avgKmPerDay.get(v.id)
          const item: ReminderItem = { ...base, kind: 'maintenance_km', remaining, overdue, dueKm }
          if (!overdue && avg && avg > 0) item.estimatedDays = Math.ceil(remaining / avg)
          items.push(item)
        }
      }
    }

    if (v.next_maintenance_date) {
      const remaining = daysBetween(today, v.next_maintenance_date)
      if (remaining <= settings.maintenance_days_threshold) {
        items.push({ ...base, kind: 'maintenance_date', remaining, overdue: remaining < 0, dueDate: v.next_maintenance_date })
      }
    }
  }

  return sortReminders(items)
}

// Avisos de seguro (vence hoy = vencido). Los usa el reporte semanal.
export function computeInsuranceAlerts(vehicles: ReminderVehicle[], settings: ReminderSettings, today: string): ReminderItem[] {
  const items: ReminderItem[] = []
  for (const v of vehicles) {
    if (!v.active || !v.insurance_expiry) continue
    const remaining = daysBetween(today, v.insurance_expiry)
    if (remaining <= settings.insurance_days_threshold) {
      items.push({ vehicleId: v.id, vehicleName: v.name, plate: v.plate, kind: 'insurance', remaining, overdue: remaining <= 0, dueDate: v.insurance_expiry })
    }
  }
  return sortReminders(items)
}

// Vencidos primero; dentro de cada grupo, por tipo (seguro, fecha, km), del más
// urgente al menos, y por nombre del vehículo.
export function sortReminders(items: ReminderItem[]): ReminderItem[] {
  return [...items].sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || a.remaining - b.remaining
    || a.vehicleName.localeCompare(b.vehicleName, 'es'))
}
```

Actualizar el comentario de cabecera del archivo: "Cálculo puro de los avisos de vencimiento (mantenimiento y seguro)…".

- [ ] **Step 4: Verificar**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/time_test.ts _tests/reminders_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/time.ts supabase/functions/_shared/reminders.ts supabase/functions/_tests/time_test.ts supabase/functions/_tests/reminders_test.ts
git commit -m "feat(functions): alertas de mantenimiento con días estimados; seguro aparte"
```

---

### Task 3: Formato común de correos y correo diario (`email_format.ts`, `reminder_email.ts`)

**Files:**
- Create: `supabase/functions/_shared/email_format.ts`
- Modify: `supabase/functions/_shared/reminder_email.ts`, `supabase/functions/_tests/reminder_email_test.ts`

- [ ] **Step 1: Tests (deben fallar)**

En `_tests/reminder_email_test.ts`:
- **Actualizar** las aserciones de asunto:
  - `'Transportes Ejemplo: 2 vencimientos — 26/09/2026'` → `'Transportes Ejemplo: 2 alertas de mantenimiento — 26/09/2026'`
  - `'…: 1 vencimiento — …'` → `'…: 1 alerta de mantenimiento — …'`
  - `'…: sin vencimientos — …'` → `'…: sin alertas de mantenimiento — …'`
  - el texto `'No hay vencimientos'` → `'No hay mantenimientos por vencer'`
- Mantener los tests existentes de `describeItem`: se re-exporta desde `reminder_email.ts`.
- Agregar:

```ts
Deno.test('describeItem: estimación de días en mantenimiento por km', () => {
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 700, overdue: false, dueKm: 126500, estimatedDays: 7 }),
    'faltan 700 km (≈ 7 días al ritmo actual; a los 126.500 km)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 50, overdue: false, dueKm: 126500, estimatedDays: 1 }),
    'faltan 50 km (≈ 1 día al ritmo actual; a los 126.500 km)')
})

Deno.test('pie del correo diario', () => {
  const e = buildReminderEmail([{ ...base, kind: 'maintenance_date', remaining: 3, overdue: false, dueDate: '2026-09-29' }], OPTS)
  assertStringIncludes(e.text, 'Recibes este aviso porque estás en la lista de avisos de la flota.')
})
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/reminder_email_test.ts`
Expected: FAIL.

- [ ] **Step 3: `email_format.ts`**

Mover a este archivo los helpers que hoy están en `reminder_email.ts` (`int`, `date`, `days`, `esc`, `KIND_LABEL`, `describeItem`, `vehicleLabel`, `section`), exportarlos y sumar la estimación:

```ts
// Helpers de formato compartidos por los correos (diario y semanal).
import type { ReminderItem, ReminderKind } from './reminders.ts'

export const KIND_LABEL: Record<ReminderKind, string> = {
  insurance: 'Seguro',
  maintenance_date: 'Mantenimiento (fecha)',
  maintenance_km: 'Mantenimiento (km)',
}

// Entero con separador de miles "." (no depende del ICU del runtime).
export function int(n: number): string {
  const s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return n < 0 && Math.round(Math.abs(n)) !== 0 ? `-${s}` : s
}

// "2026-09-26" → "26/09/2026"
export function date(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

// "2026-09-26" → "26/09"
export function shortDate(d: string): string {
  const [, m, day] = d.split('-')
  return `${day}/${m}`
}

export function days(n: number): string {
  return `${n} día${n === 1 ? '' : 's'}`
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function describeItem(item: ReminderItem): string {
  if (item.kind === 'maintenance_km') {
    const due = int(item.dueKm ?? 0)
    if (item.remaining > 0) {
      return item.estimatedDays != null
        ? `faltan ${int(item.remaining)} km (≈ ${days(item.estimatedDays)} al ritmo actual; a los ${due} km)`
        : `faltan ${int(item.remaining)} km (a los ${due} km)`
    }
    if (item.remaining === 0) return `llegó a los ${due} km`
    return `pasado por ${int(-item.remaining)} km (tocaba a los ${due} km)`
  }
  const d = date(item.dueDate ?? '')
  if (item.remaining > 0) return `vence en ${days(item.remaining)} (${d})`
  if (item.remaining === 0) return `vence hoy (${d})`
  return `vencido hace ${days(-item.remaining)} (${d})`
}

export function vehicleLabel(item: { vehicleName: string; plate: string | null }): string {
  return item.plate ? `${item.vehicleName} (${item.plate})` : item.vehicleName
}

export const RED = '#dc2626'
export const AMBER = '#b45309'

// Tabla HTML de avisos con título (vacía si no hay avisos).
export function alertsSection(title: string, color: string, items: ReminderItem[]): string {
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

// Líneas de texto plano de un grupo de avisos.
export function alertsText(title: string, items: ReminderItem[]): string[] {
  return items.length === 0 ? [] : ['', `${title} (${items.length})`, ...items.map(i => `- ${vehicleLabel(i)} · ${KIND_LABEL[i.kind]}: ${describeItem(i)}`)]
}

// Envoltura HTML común (encabezado, cuerpo, botón y pie).
export function emailShell(o: { appName: string; subtitle: string; body: string; url: string; footer: string }): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 4px;font-size:18px;color:#111827">${esc(o.appName)}</h1>
    <p style="margin:0;font-size:13px;color:#6b7280">${esc(o.subtitle)}</p>
    ${o.body}
    <p style="margin:24px 0">
      <a href="${esc(o.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Abrir ${esc(o.appName)}</a>
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af">${esc(o.footer)}</p>
  </div>
</body></html>`
}

export function appLink(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/vehiculos`
}
```

**Nota:** el `int` anterior hacía `Math.round(n).toString()`, que en negativos daba `-300` sin separador. Todos los llamadores pasan valores positivos (usan `-item.remaining`), pero esta versión maneja bien los negativos por si alguno los usa en el semanal.

- [ ] **Step 4: Reescribir `reminder_email.ts` sobre esos helpers**

```ts
// Correo diario de alertas de mantenimiento: asunto, HTML y texto plano.
import type { ReminderItem } from './reminders.ts'
import { alertsSection, alertsText, appLink, date, emailShell, RED, AMBER } from './email_format.ts'

export { describeItem } from './email_format.ts'

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

const FOOTER = 'Recibes este aviso porque estás en la lista de avisos de la flota. Se repite cada día hasta que se actualice el mantenimiento en la app.'

export function buildReminderEmail(items: ReminderItem[], opts: EmailOptions): EmailContent {
  const overdue = items.filter(i => i.overdue)
  const upcoming = items.filter(i => !i.overdue)
  const n = items.length
  const subject = n === 0
    ? `${opts.appName}: sin alertas de mantenimiento — ${date(opts.today)}`
    : `${opts.appName}: ${n} alerta${n === 1 ? '' : 's'} de mantenimiento — ${date(opts.today)}`
  const url = appLink(opts.appUrl)

  const body = n === 0
    ? '<p style="font-size:14px;color:#374151">No hay mantenimientos por vencer.</p>'
    : alertsSection('Vencidos', RED, overdue) + alertsSection('Próximos', AMBER, upcoming)

  const html = emailShell({ appName: opts.appName, subtitle: `Mantenimientos al ${date(opts.today)}`, body, url, footer: FOOTER })

  const text = [
    `${opts.appName} — mantenimientos al ${date(opts.today)}`,
    ...(n === 0 ? ['', 'No hay mantenimientos por vencer.'] : [...alertsText('VENCIDOS', overdue), ...alertsText('PRÓXIMOS', upcoming)]),
    '', `Abrir: ${url}`,
    '', FOOTER,
  ].join('\n')

  return { subject, html, text }
}
```

- [ ] **Step 5: Verificar y commit**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/reminder_email_test.ts _tests/reminders_test.ts`
Expected: PASS. El test de flujo `send_reminders_test.ts` puede fallar en el asunto; se corrige en la Task 5.

```bash
git add supabase/functions/_shared/email_format.ts supabase/functions/_shared/reminder_email.ts supabase/functions/_tests/reminder_email_test.ts
git commit -m "feat(functions): formato común de correos y alerta diaria de mantenimiento"
```

---

### Task 4: Flujo compartido de envío (`notify.ts`)

**Files:**
- Create: `supabase/functions/_shared/notify.ts`

- [ ] **Step 1: Implementación**

Se prueba a través de los tests de flujo de las Tasks 5 y 8.

```ts
// Flujo común de los correos programados (alerta diaria y reporte semanal):
// configuración, destinatarios, reserva atómica del día por tipo, envío por
// Resend y registro en reminder_log.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { json, HttpError } from './http.ts'
import { emailConfig, sendEmail, ResendHttpError } from './resend.ts'
import type { EmailContent } from './reminder_email.ts'

export const SEND_HOUR = 7

export type NotificationKind = 'daily' | 'weekly'
type Status = 'sending' | 'sent' | 'nothing_to_send' | 'error'

export interface NotificationSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
  email_reminders_enabled: boolean
  notification_emails: string[]
  weekly_report_enabled: boolean
  weekly_report_day: number
}

export function resendConfigured(): boolean {
  return (Deno.env.get('RESEND_API_KEY') ?? '').trim() !== ''
}

export async function loadNotificationSettings(db: SupabaseClient): Promise<NotificationSettings> {
  const { data, error } = await db
    .from('fleet_settings')
    .select('maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled, notification_emails, weekly_report_enabled, weekly_report_day')
    .single()
  if (error || !data) throw new HttpError(500, `No se pudo leer la configuración: ${error?.message ?? 'sin fila'}`)
  return { ...data, notification_emails: data.notification_emails ?? [] } as NotificationSettings
}

// La lista configurada o, si está vacía, los administradores activos.
export async function resolveRecipients(db: SupabaseClient, configured: string[]): Promise<string[]> {
  const list = [...new Set((configured ?? []).map(e => e.trim()).filter(Boolean))]
  if (list.length > 0) return list
  const { data, error } = await db.from('profiles').select('email').eq('role', 'admin').eq('active', true)
  if (error) throw new HttpError(500, `No se pudo leer los administradores: ${error.message}`)
  const admins = (data ?? []).map((a: { email: string }) => a.email).filter(Boolean)
  if (admins.length === 0) throw new HttpError(500, 'No hay destinatarios: la lista está vacía y no hay administradores activos con correo.')
  return admins
}

export interface Prepared {
  itemCount: number
  nothingToSend: boolean
  render: (cfg: { appName: string; appUrl: string }) => EmailContent
}

export interface DeliverOptions {
  kind: NotificationKind
  today: string
  test: boolean
  // Modo prueba: a quién se envía (el admin que lo pidió).
  testRecipients?: string[]
  // Destinatarios configurados (modo programado).
  configuredRecipients: string[]
  prepare: () => Promise<Prepared>
}

// Modo programado: reserva el día (kind, fecha) y ejecuta el envío con la
// máquina de estados:
// - falla antes de llamar a Resend, o Resend responde con error HTTP → 'error'
//   (la hora siguiente reintenta);
// - timeout o corte de red con el envío ya intentado → 'sending' ("posiblemente
//   enviado"; no se reintenta, para no duplicar);
// - éxito → 'sent' (registro best-effort: si falla, no se reenvía).
// Modo prueba: no reserva ni registra; envía a testRecipients.
export async function deliver(db: SupabaseClient, o: DeliverOptions): Promise<Response> {
  const { kind, today, test } = o

  const log = async (status: Status, recipients: string[], itemCount: number, error: string | null = null) => {
    const { error: e } = await db.from('reminder_log').upsert(
      { kind, local_date: today, status, recipients, item_count: itemCount, error },
      { onConflict: 'kind,local_date' },
    )
    if (e) throw new HttpError(500, `No se pudo registrar el envío: ${e.message}`)
  }
  const logBestEffort = async (status: Status, recipients: string[], itemCount: number, error: string | null = null) => {
    try {
      await log(status, recipients, itemCount, error)
    } catch (e) {
      console.error(`${kind}: no se pudo registrar el envío`, e instanceof Error ? e.message : e)
    }
  }

  if (!test) {
    const { data: claimed, error } = await db.rpc('flota_claim_notification', { p_kind: kind, p_date: today })
    if (error) throw new HttpError(500, `No se pudo reservar el envío del día: ${error.message}`)
    if (!claimed) return json({ skipped: 'already_sent', kind, today })
  }

  let attempted = false
  let itemCount = 0
  let recipients: string[] = []
  try {
    const prepared = await o.prepare()
    itemCount = prepared.itemCount

    if (!test && prepared.nothingToSend) {
      await log('nothing_to_send', [], itemCount)
      return json({ status: 'nothing_to_send', kind, today })
    }

    recipients = test ? (o.testRecipients ?? []) : await resolveRecipients(db, o.configuredRecipients)
    if (recipients.length === 0) throw new HttpError(400, 'No hay destinatarios para la prueba.')

    const cfg = emailConfig()
    const email = prepared.render({ appName: cfg.appName, appUrl: cfg.appUrl })
    attempted = true
    await sendEmail(cfg, { to: recipients, ...email })

    if (!test) await logBestEffort('sent', recipients, itemCount)
    return json({ status: 'sent', kind, items: itemCount, recipients: recipients.length, test, today })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const possiblySent = attempted && !(e instanceof ResendHttpError)
    if (!test) await logBestEffort(possiblySent ? 'sending' : 'error', recipients, itemCount, message)
    if (possiblySent) throw new HttpError(502, message)
    if (e instanceof HttpError) throw e
    if (e instanceof ResendHttpError) throw new HttpError(502, message)
    throw new HttpError(500, message)
  }
}
```

- [ ] **Step 2: Verificar tipos y commit**

Run: `cd supabase/functions && npx -y deno check _shared/notify.ts`
Expected: sin errores.

```bash
git add supabase/functions/_shared/notify.ts
git commit -m "feat(functions): flujo compartido de envío programado (notify)"
```

---

### Task 5: `send-reminders` sobre `notify.ts`

**Files:**
- Modify (reescribir): `supabase/functions/send-reminders/handler.ts`
- Modify: `supabase/functions/_tests/send_reminders_test.ts`

- [ ] **Step 1: Adaptar el test de flujo (debe fallar)**

Cambios en `_tests/send_reminders_test.ts`:

1. **Estado:**
   - En `state.settings` agregar `notification_emails: [] as string[], weekly_report_enabled: true, weekly_report_day: 1`.
   - Agregar `mileage: [] as { vehicle_id: string; date: string; km: number }[]`.
   - En `resetState()`, restablecer `notification_emails = []` y `mileage = []`.
2. **Registro por tipo:** `state.log` usa la clave `` `${kind}:${local_date}` ``.
   - En el mock del upsert (`/rest/v1/reminder_log`), exigir `on_conflict === 'kind,local_date'` en lugar de `'local_date'`, y guardar con `state.log.set(\`${row.kind}:${row.local_date}\`, row)`.
   - Todas las aserciones `state.log.get('2026-09-26')` pasan a `state.log.get('daily:2026-09-26')`.
3. **Reserva:** reemplazar la ruta `/rest/v1/rpc/flota_claim_reminder_day` por `/rest/v1/rpc/flota_claim_notification`. Lee `{ p_kind, p_date }` y usa la clave `` `${p_kind}:${p_date}` ``, con la misma semántica.
4. **Kilometraje:** agregar la ruta `/rest/v1/vehicle_daily_mileage`, que devuelve `Response.json(state.mileage)`.
5. **Asuntos y cantidades:** la fixture `v1` tiene el seguro vencido y el mantenimiento por km a 500. Ahora el diario solo cuenta mantenimiento, así que:
   - `res.items` pasa de 2 a 1;
   - el asunto esperado pasa a `'1 alerta de mantenimiento — 26/09/2026'`;
   - en el paso "prueba con 0 avisos" el asunto esperado pasa a contener `'sin alertas de mantenimiento'`.
6. **Paso "desactivado":** ahora espera `res.skipped === 'disabled'`, cero correos y `state.log.size === 0`: no reserva ni registra.
7. **Pasos nuevos:**

```ts
    await t.step('destinatarios configurados reemplazan a los admins', async () => {
      resetState()
      state.settings.notification_emails = ['flota@ejemplo.test', 'jefe@ejemplo.test']
      const res = await (await at(SIETE)(cron())).json()
      assertEquals(res.status, 'sent')
      assertEquals(state.emails[0].to, ['flota@ejemplo.test', 'jefe@ejemplo.test'])
    })

    await t.step('estimación de días con el kilometraje de los últimos 28 días', async () => {
      resetState()
      // 14 días × 100 km → promedio 50 km/día; faltan 500 km → ≈ 10 días
      state.mileage = Array.from({ length: 14 }, (_, i) => ({ vehicle_id: 'v1', date: `2026-09-${String(12 + i).padStart(2, '0')}`, km: 100 }))
      await (await at(SIETE)(cron())).json()
      assertStringIncludes(String(state.emails[0].text), '≈ 10 días al ritmo actual')
    })

    await t.step('desactivado y reactivado el mismo día: la hora siguiente envía', async () => {
      resetState()
      state.settings.email_reminders_enabled = false
      assertEquals((await (await at(SIETE)(cron())).json()).skipped, 'disabled')
      state.settings.email_reminders_enabled = true
      assertEquals((await (await at('2026-09-26T12:10:00Z')(cron())).json()).status, 'sent')
    })
```

Si el `resetState()` actual no restablece `state.settings.email_reminders_enabled`, hacer que lo haga.

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/send_reminders_test.ts`
Expected: FAIL (el handler todavía usa `flota_claim_reminder_day`).

- [ ] **Step 2: Reescribir `send-reminders/handler.ts`**

```ts
// send-reminders: alerta diaria de mantenimiento (por km y por fecha).
//
// Modo programado (pg_cron, header x-cron-secret): a partir de las 7:00 en
// APP_TIMEZONE, una vez por día y solo si hay mantenimientos por vencer o
// vencidos. Ver _shared/notify.ts para la máquina de estados.
// Modo prueba (admin con sesión, body { test: true }): envía las alertas de hoy
// solo al admin que llama, a cualquier hora y sin registrar nada.
import { json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin } from '../_shared/supabase.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { addDays, appTimeZone, dateInTz, hourInTz } from '../_shared/time.ts'
import { averageKmPerDay, computeReminders } from '../_shared/reminders.ts'
import { buildReminderEmail } from '../_shared/reminder_email.ts'
import { deliver, loadNotificationSettings, resendConfigured, SEND_HOUR } from '../_shared/notify.ts'

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

    if (!test) {
      if (hourInTz(now, tz) < SEND_HOUR) return json({ skipped: 'hour', today })
      // Sin Resend configurado los correos están inactivos: no se reserva el día.
      if (!resendConfigured()) return json({ skipped: 'not_configured', today })
    }

    const settings = await loadNotificationSettings(db)
    // Desactivado: no se reserva ni registra, así reactivarlo más tarde sirve el mismo día.
    if (!test && !settings.email_reminders_enabled) return json({ skipped: 'disabled', today })

    let testRecipients: string[] | undefined
    if (test) {
      if (!caller?.user.email) throw new HttpError(400, 'Tu usuario no tiene correo; no se puede enviar la prueba.')
      testRecipients = [caller.user.email]
    }

    return deliver(db, {
      kind: 'daily',
      today,
      test,
      testRecipients,
      configuredRecipients: settings.notification_emails,
      prepare: async () => {
        const [vRes, oRes, mRes] = await Promise.all([
          db.from('vehicles').select('id, name, plate, active, next_maintenance_km, next_maintenance_date, insurance_expiry, gps_device_id').eq('active', true),
          db.from('vehicle_odometer').select('vehicle_id, odometer_km, has_data'),
          db.from('vehicle_daily_mileage').select('vehicle_id, date, km').gte('date', addDays(today, -28)).lt('date', today),
        ])
        const err = vRes.error ?? oRes.error ?? mRes.error
        if (err) throw new HttpError(500, err.message)

        const byVehicle = new Map<string, { date: string; km: number }[]>()
        for (const m of mRes.data ?? []) {
          const list = byVehicle.get(m.vehicle_id) ?? []
          list.push({ date: m.date, km: Number(m.km) })
          byVehicle.set(m.vehicle_id, list)
        }
        const averages = new Map<string, number>()
        for (const [id, rows] of byVehicle) {
          const avg = averageKmPerDay(rows, today)
          if (avg != null) averages.set(id, avg)
        }

        const items = computeReminders(vRes.data ?? [], oRes.data ?? [], settings, today, averages)
        return {
          itemCount: items.length,
          nothingToSend: items.length === 0,
          render: cfg => buildReminderEmail(items, { ...cfg, today }),
        }
      },
    })
  }
}
```

- [ ] **Step 3: Verificar**

Run:
```bash
cd supabase/functions
npx -y deno test --allow-net --allow-env _tests/
npx -y deno check send-reminders/index.ts
```
Expected: todos PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-reminders/handler.ts supabase/functions/_tests/send_reminders_test.ts
git commit -m "refactor(functions): send-reminders sobre notify, solo mantenimiento y estimación"
```

---

### Task 6: Cálculo del reporte semanal (`weekly_report.ts`)

**Files:**
- Create: `supabase/functions/_shared/weekly_report.ts`
- Create: `supabase/functions/_tests/weekly_report_test.ts`

- [ ] **Step 1: Tests (deben fallar)**

```ts
import { assertEquals } from 'jsr:@std/assert@1'
import { buildWeeklyReport, type WeeklyVehicle } from '../_shared/weekly_report.ts'

const S = { maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30 }
const TODAY = '2026-09-28' // lunes

function veh(p: Partial<WeeklyVehicle> & { id: string }): WeeklyVehicle {
  return {
    name: p.id, plate: null, active: true, next_maintenance_km: null, next_maintenance_date: null,
    insurance_company: null, insurance_expiry: null, gps_device_id: null, driver: null, ...p,
  }
}

Deno.test('período: los 7 días anteriores a hoy', () => {
  const r = buildWeeklyReport({ vehicles: [], odometers: [], mileage: [] }, S, TODAY)
  assertEquals([r.periodFrom, r.periodTo], ['2026-09-21', '2026-09-27'])
  assertEquals(r.totals, { vehicles: 0, weekKm: 0, alerts: 0 })
})

Deno.test('filas: odómetro, km de la semana (solo con GPS), conductor y orden por nombre', () => {
  const r = buildWeeklyReport({
    vehicles: [
      veh({ id: 'b', name: 'Sedán', gps_device_id: null, driver: { full_name: 'Ana' } }),
      veh({ id: 'a', name: 'Pickup', plate: 'AB-1', gps_device_id: '111' }),
      veh({ id: 'z', name: 'Inactivo', active: false }),
    ],
    odometers: [
      { vehicle_id: 'a', odometer_km: '51176.47', has_data: true },
      { vehicle_id: 'b', odometer_km: 0, has_data: false },
    ],
    mileage: [
      { vehicle_id: 'a', date: '2026-09-20', km: 999 },   // fuera del período
      { vehicle_id: 'a', date: '2026-09-21', km: 100.5 },
      { vehicle_id: 'a', date: '2026-09-27', km: 50.25 },
      { vehicle_id: 'a', date: '2026-09-28', km: 999 },   // hoy, fuera
    ],
  }, S, TODAY)
  assertEquals(r.rows.map(x => [x.name, x.odometerKm, x.weekKm, x.driver]), [
    ['Pickup', 51176, 150.75, null],
    ['Sedán', null, null, 'Ana'],
  ])
  assertEquals(r.totals.vehicles, 2)
  assertEquals(r.totals.weekKm, 150.75)
})

Deno.test('mantenimiento: km por defecto; fecha si solo la fecha está en alerta', () => {
  const r = buildWeeklyReport({
    vehicles: [
      veh({ id: 'km', next_maintenance_km: 60000, next_maintenance_date: '2026-12-01' }),
      veh({ id: 'fecha', next_maintenance_km: 60000, next_maintenance_date: '2026-10-01' }),
      veh({ id: 'solo-fecha', next_maintenance_date: '2027-01-01' }),
      veh({ id: 'nada' }),
    ],
    odometers: ['km', 'fecha', 'solo-fecha', 'nada'].map(id => ({ vehicle_id: id, odometer_km: 50000, has_data: true })),
    mileage: [],
  }, S, TODAY)
  const m = Object.fromEntries(r.rows.map(x => [x.vehicleId, x.maintenance]))
  assertEquals(m.km, { kind: 'km', remainingKm: 10000 })
  assertEquals(m.fecha, { kind: 'date', remainingDays: 3, date: '2026-10-01' })
  assertEquals(m['solo-fecha'], { kind: 'date', remainingDays: 95, date: '2027-01-01' })
  assertEquals(m.nada, null)
})

Deno.test('alertas: mantenimiento y seguro, ordenadas, con total', () => {
  const r = buildWeeklyReport({
    vehicles: [
      veh({ id: 'a', name: 'A', next_maintenance_km: 50500, insurance_expiry: '2026-09-28', insurance_company: 'Aseg' }),
      veh({ id: 'b', name: 'B', insurance_expiry: '2027-01-01' }),
    ],
    odometers: [{ vehicle_id: 'a', odometer_km: 50000, has_data: true }],
    mileage: [],
  }, S, TODAY)
  assertEquals(r.attention.map(i => [i.vehicleId, i.kind, i.overdue]), [['a', 'insurance', true], ['a', 'maintenance_km', false]])
  assertEquals(r.totals.alerts, 2)
  const a = r.rows.find(x => x.vehicleId === 'a')!
  assertEquals(a.insurance, { expiry: '2026-09-28', remainingDays: 0, company: 'Aseg' })
  assertEquals(a.alerts.length, 2)
})
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/weekly_report_test.ts`
Expected: FAIL (el módulo no existe).

- [ ] **Step 3: Implementación**

`_shared/weekly_report.ts`:

```ts
// Cálculo puro del reporte semanal: una fila por vehículo activo más las
// alertas (mantenimiento con las reglas del diario y seguro).
import { addDays, daysBetween } from './time.ts'
import {
  averageKmPerDay, computeInsuranceAlerts, computeReminders, sortReminders,
  type OdometerRow, type ReminderItem, type ReminderSettings, type ReminderVehicle,
} from './reminders.ts'

export interface WeeklyVehicle extends ReminderVehicle {
  insurance_company: string | null
  gps_device_id: string | null
  driver: { full_name: string } | null
}

export interface MileageRow {
  vehicle_id: string
  date: string
  km: number | string
}

export type MaintenanceInfo =
  | { kind: 'km'; remainingKm: number }
  | { kind: 'date'; remainingDays: number; date: string }
  | null

export interface WeeklyVehicleRow {
  vehicleId: string
  name: string
  plate: string | null
  driver: string | null
  odometerKm: number | null
  weekKm: number | null
  maintenance: MaintenanceInfo
  insurance: { expiry: string; remainingDays: number; company: string | null } | null
  alerts: ReminderItem[]
}

export interface WeeklyReport {
  periodFrom: string
  periodTo: string
  totals: { vehicles: number; weekKm: number; alerts: number }
  attention: ReminderItem[]
  rows: WeeklyVehicleRow[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function buildWeeklyReport(
  input: { vehicles: WeeklyVehicle[]; odometers: OdometerRow[]; mileage: MileageRow[] },
  settings: ReminderSettings,
  today: string,
): WeeklyReport {
  const periodFrom = addDays(today, -7)
  const periodTo = addDays(today, -1)
  const odoById = new Map(input.odometers.map(o => [o.vehicle_id, o]))

  const mileageByVehicle = new Map<string, { date: string; km: number }[]>()
  for (const m of input.mileage) {
    const list = mileageByVehicle.get(m.vehicle_id) ?? []
    list.push({ date: m.date, km: Number(m.km) })
    mileageByVehicle.set(m.vehicle_id, list)
  }
  const averages = new Map<string, number>()
  for (const [id, list] of mileageByVehicle) {
    const avg = averageKmPerDay(list, today)
    if (avg != null) averages.set(id, avg)
  }

  const rows: WeeklyVehicleRow[] = input.vehicles
    .filter(v => v.active)
    .map(v => {
      const odo = odoById.get(v.id)
      const hasOdo = !!odo?.has_data
      const maintenanceAlerts = computeReminders([v], input.odometers, settings, today, averages)
      const insuranceAlerts = computeInsuranceAlerts([v], settings, today)

      const km: MaintenanceInfo = v.next_maintenance_km != null && hasOdo && Number(v.next_maintenance_km) > 0
        ? { kind: 'km', remainingKm: Math.round(Number(v.next_maintenance_km) - Number(odo!.odometer_km)) }
        : null
      const byDate: MaintenanceInfo = v.next_maintenance_date
        ? { kind: 'date', remainingDays: daysBetween(today, v.next_maintenance_date), date: v.next_maintenance_date }
        : null
      const dateAlert = maintenanceAlerts.some(a => a.kind === 'maintenance_date')
      const kmAlert = maintenanceAlerts.some(a => a.kind === 'maintenance_km')
      const maintenance = km && byDate ? (dateAlert && !kmAlert ? byDate : km) : (km ?? byDate)

      const week = mileageByVehicle.get(v.id) ?? []
      const weekKm = v.gps_device_id
        ? round2(week.filter(m => m.date >= periodFrom && m.date <= periodTo).reduce((s, m) => s + m.km, 0))
        : null

      return {
        vehicleId: v.id,
        name: v.name,
        plate: v.plate,
        driver: v.driver?.full_name ?? null,
        odometerKm: hasOdo ? Math.round(Number(odo!.odometer_km)) : null,
        weekKm,
        maintenance,
        insurance: v.insurance_expiry
          ? { expiry: v.insurance_expiry, remainingDays: daysBetween(today, v.insurance_expiry), company: v.insurance_company }
          : null,
        alerts: sortReminders([...maintenanceAlerts, ...insuranceAlerts]),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))

  const attention = sortReminders(rows.flatMap(r => r.alerts))
  return {
    periodFrom,
    periodTo,
    totals: {
      vehicles: rows.length,
      weekKm: round2(rows.reduce((s, r) => s + (r.weekKm ?? 0), 0)),
      alerts: attention.length,
    },
    attention,
    rows,
  }
}
```

- [ ] **Step 4: Verificar y commit**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/weekly_report_test.ts`
Expected: PASS (4 tests).

```bash
git add supabase/functions/_shared/weekly_report.ts supabase/functions/_tests/weekly_report_test.ts
git commit -m "feat(functions): cálculo del reporte semanal"
```

---

### Task 7: Correo semanal (`weekly_email.ts`)

**Files:**
- Create: `supabase/functions/_shared/weekly_email.ts`
- Create: `supabase/functions/_tests/weekly_email_test.ts`

- [ ] **Step 1: Tests (deben fallar)**

```ts
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildWeeklyEmail } from '../_shared/weekly_email.ts'
import type { WeeklyReport } from '../_shared/weekly_report.ts'

const OPTS = { appName: 'Transportes Ejemplo', appUrl: 'https://flota.ejemplo.test', weekday: 1 }

function report(p: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    periodFrom: '2026-09-21', periodTo: '2026-09-27',
    totals: { vehicles: 1, weekKm: 1234.5, alerts: 0 },
    attention: [],
    rows: [{
      vehicleId: 'a', name: 'Pickup', plate: 'AB-1', driver: 'Ana', odometerKm: 51176, weekKm: 1234.5,
      maintenance: { kind: 'km', remainingKm: 8824 }, insurance: { expiry: '2027-03-15', remainingDays: 168, company: 'Aseg' }, alerts: [],
    }],
    ...p,
  }
}

Deno.test('asunto con el período', () => {
  assertEquals(buildWeeklyEmail(report(), OPTS).subject, 'Transportes Ejemplo: reporte semanal — 21/09 al 27/09/2026')
})

Deno.test('resumen, sin alertas y tabla de vehículos', () => {
  const e = buildWeeklyEmail(report(), OPTS)
  assertStringIncludes(e.html, 'Sin alertas esta semana.')
  assertStringIncludes(e.html, '1.235 km') // km de la flota redondeados
  assertStringIncludes(e.html, '51.176 km')
  assertStringIncludes(e.html, 'faltan 8.824 km')
  assertStringIncludes(e.html, 'vence en 168 días (15/03/2027)')
  assertStringIncludes(e.html, 'Ana')
  assertStringIncludes(e.text, '- Pickup (AB-1) · Ana · 51.176 km · semana 1.235 km')
  assertStringIncludes(e.text, 'Se envía cada lunes')
})

Deno.test('sin GPS, sin odómetro y alertas', () => {
  const e = buildWeeklyEmail(report({
    totals: { vehicles: 1, weekKm: 0, alerts: 1 },
    attention: [{ vehicleId: 'a', vehicleName: 'Pickup', plate: 'AB-1', kind: 'insurance', remaining: -2, overdue: true, dueDate: '2026-09-26' }],
    rows: [{ ...report().rows[0], weekKm: null, odometerKm: null, maintenance: null,
      insurance: { expiry: '2026-09-26', remainingDays: -2, company: null },
      alerts: [{ vehicleId: 'a', vehicleName: 'Pickup', plate: 'AB-1', kind: 'insurance', remaining: -2, overdue: true, dueDate: '2026-09-26' }] }],
  }), OPTS)
  assertStringIncludes(e.html, 'sin GPS')
  assertStringIncludes(e.html, 'Vencidos (1)')
  assertStringIncludes(e.html, 'vencido hace 2 días (26/09/2026)')
  assert(!e.html.includes('Sin alertas esta semana.'))
})

Deno.test('escapa HTML', () => {
  const e = buildWeeklyEmail(report({ rows: [{ ...report().rows[0], name: '<b>x</b>', driver: '<i>y</i>' }] }), OPTS)
  assert(!e.html.includes('<b>x</b>'))
  assertStringIncludes(e.html, '&lt;i&gt;y&lt;/i&gt;')
})
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/weekly_email_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementación**

`_shared/weekly_email.ts`:

```ts
// Correo del reporte semanal: resumen, alertas y tabla de todos los vehículos.
import type { EmailContent } from './reminder_email.ts'
import type { WeeklyReport, WeeklyVehicleRow } from './weekly_report.ts'
import type { ReminderKind } from './reminders.ts'
import { alertsSection, alertsText, appLink, date, days, emailShell, esc, int, shortDate, AMBER, RED } from './email_format.ts'

const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']

export interface WeeklyEmailOptions {
  appName: string
  appUrl: string
  weekday: number // 1 = lunes … 7 = domingo
}

function tone(row: WeeklyVehicleRow, kind: ReminderKind): string {
  const alert = row.alerts.find(a => a.kind === kind)
  if (!alert) return '#374151'
  return alert.overdue ? RED : AMBER
}

function maintenanceText(row: WeeklyVehicleRow): { text: string; color: string } {
  const m = row.maintenance
  if (!m) return { text: '—', color: '#9ca3af' }
  if (m.kind === 'km') {
    const text = m.remainingKm > 0 ? `faltan ${int(m.remainingKm)} km` : m.remainingKm === 0 ? 'llegó al km' : `pasado por ${int(-m.remainingKm)} km`
    return { text, color: tone(row, 'maintenance_km') }
  }
  const text = m.remainingDays > 0 ? `en ${days(m.remainingDays)} (${date(m.date)})` : m.remainingDays === 0 ? `hoy (${date(m.date)})` : `vencido hace ${days(-m.remainingDays)} (${date(m.date)})`
  return { text, color: tone(row, 'maintenance_date') }
}

function insuranceText(row: WeeklyVehicleRow): { text: string; color: string } {
  const i = row.insurance
  if (!i) return { text: '—', color: '#9ca3af' }
  const d = date(i.expiry)
  const text = i.remainingDays > 0 ? `vence en ${days(i.remainingDays)} (${d})` : i.remainingDays === 0 ? `vence hoy (${d})` : `vencido hace ${days(-i.remainingDays)} (${d})`
  return { text, color: tone(row, 'insurance') }
}

const TH = 'padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;font-size:12px;color:#6b7280;font-weight:600'
const TD = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top'

export function buildWeeklyEmail(report: WeeklyReport, opts: WeeklyEmailOptions): EmailContent {
  const period = `${shortDate(report.periodFrom)} al ${date(report.periodTo)}`
  const subject = `${opts.appName}: reporte semanal — ${period}`
  const url = appLink(opts.appUrl)
  const weekday = WEEKDAYS[(opts.weekday - 1 + 7) % 7]
  const footer = `Reporte semanal de la flota. Se envía cada ${weekday} a la lista de avisos.`
  const overdue = report.attention.filter(i => i.overdue)
  const upcoming = report.attention.filter(i => !i.overdue)

  const summary = `
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin-top:16px;border-collapse:collapse">
      <tr>
        <td style="padding:12px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:700;color:#111827">${report.totals.vehicles}</div><div style="font-size:12px;color:#6b7280">vehículos activos</div></td>
        <td style="width:8px"></td>
        <td style="padding:12px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:700;color:#111827">${int(report.totals.weekKm)} km</div><div style="font-size:12px;color:#6b7280">recorridos en la semana</div></td>
        <td style="width:8px"></td>
        <td style="padding:12px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:700;color:${report.totals.alerts > 0 ? RED : '#111827'}">${report.totals.alerts}</div><div style="font-size:12px;color:#6b7280">alertas</div></td>
      </tr>
    </table>`

  const attention = report.attention.length === 0
    ? '<h2 style="margin:24px 0 8px;font-size:16px;color:#111827">Requieren atención</h2><p style="font-size:14px;color:#374151">Sin alertas esta semana.</p>'
    : '<h2 style="margin:24px 0 0;font-size:16px;color:#111827">Requieren atención</h2>' + alertsSection('Vencidos', RED, overdue) + alertsSection('Próximos', AMBER, upcoming)

  const rows = report.rows.map(r => {
    const m = maintenanceText(r)
    const i = insuranceText(r)
    return `
      <tr>
        <td style="${TD};font-weight:600;color:#111827">${esc(r.name)}${r.plate ? `<div style="font-weight:400;font-size:12px;color:#6b7280">${esc(r.plate)}</div>` : ''}</td>
        <td style="${TD};color:#374151">${esc(r.driver ?? '—')}</td>
        <td style="${TD};color:#374151;white-space:nowrap">${r.odometerKm != null ? `${int(r.odometerKm)} km` : '—'}</td>
        <td style="${TD};color:#374151;white-space:nowrap">${r.weekKm != null ? `${int(r.weekKm)} km` : 'sin GPS'}</td>
        <td style="${TD};color:${m.color}">${esc(m.text)}</td>
        <td style="${TD};color:${i.color}">${esc(i.text)}</td>
      </tr>`
  }).join('')

  const table = `
    <h2 style="margin:24px 0 8px;font-size:16px;color:#111827">Vehículos</h2>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">
      <tr><th style="${TH}">Vehículo</th><th style="${TH}">Conductor</th><th style="${TH}">Odómetro</th><th style="${TH}">Km semana</th><th style="${TH}">Próx. mantenimiento</th><th style="${TH}">Seguro</th></tr>${rows}
    </table>`

  const html = emailShell({ appName: opts.appName, subtitle: `Reporte semanal · ${period}`, body: summary + attention + table, url, footer })

  const text = [
    `${opts.appName} — reporte semanal ${period}`,
    '',
    `Vehículos activos: ${report.totals.vehicles} · Km de la flota: ${int(report.totals.weekKm)} km · Alertas: ${report.totals.alerts}`,
    ...(report.attention.length === 0 ? ['', 'Sin alertas esta semana.'] : [...alertsText('VENCIDOS', overdue), ...alertsText('PRÓXIMOS', upcoming)]),
    '', 'VEHÍCULOS',
    ...report.rows.map(r => {
      const label = r.plate ? `${r.name} (${r.plate})` : r.name
      const odo = r.odometerKm != null ? `${int(r.odometerKm)} km` : '—'
      const week = r.weekKm != null ? `semana ${int(r.weekKm)} km` : 'sin GPS'
      return `- ${label} · ${r.driver ?? '—'} · ${odo} · ${week} · mant.: ${maintenanceText(r).text} · seguro: ${insuranceText(r).text}`
    }),
    '', `Abrir: ${url}`,
    '', footer,
  ].join('\n')

  return { subject, html, text }
}
```

- [ ] **Step 4: Verificar y commit**

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/weekly_email_test.ts`
Expected: PASS (4 tests).

```bash
git add supabase/functions/_shared/weekly_email.ts supabase/functions/_tests/weekly_email_test.ts
git commit -m "feat(functions): correo del reporte semanal"
```

---

### Task 8: Función `send-weekly-report`

**Files:**
- Create: `supabase/functions/send-weekly-report/handler.ts`, `supabase/functions/send-weekly-report/index.ts`
- Create: `supabase/functions/_tests/send_weekly_report_test.ts`
- Modify: `supabase/config.toml`

- [ ] **Step 1: Test de flujo (debe fallar)**

`_tests/send_weekly_report_test.ts`:

```ts
// Simula PostgREST, Auth y Resend y ejercita send-weekly-report.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'

const PORT = 54875
const BASE = `http://127.0.0.1:${PORT}`
Deno.env.set('SUPABASE_URL', BASE)
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_test' }))
Deno.env.set('APP_TIMEZONE', 'America/La_Paz')
Deno.env.set('SYNC_CRON_SECRET', 'secreto-de-prueba-123456')
Deno.env.set('RESEND_API_URL', `${BASE}/resend/emails`)
Deno.env.set('RESEND_API_KEY', 're_test')
Deno.env.set('EMAIL_FROM', 'Flota <avisos@ejemplo.test>')
Deno.env.set('APP_URL', 'https://flota.ejemplo.test')

const { createHandler } = await import('../send-weekly-report/handler.ts')
const { withErrors } = await import('../_shared/http.ts')

const state = {
  settings: {
    maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30,
    email_reminders_enabled: true, notification_emails: [] as string[], weekly_report_enabled: true, weekly_report_day: 1,
  },
  vehicles: [
    { id: 'v1', name: 'Pickup', plate: 'AB-1', active: true, next_maintenance_km: 60000, next_maintenance_date: null, insurance_company: 'Aseg', insurance_expiry: '2026-09-20', gps_device_id: '111', driver: { full_name: 'Ana' } },
  ] as Record<string, unknown>[],
  odometers: [{ vehicle_id: 'v1', odometer_km: 51000, has_data: true }],
  mileage: [{ vehicle_id: 'v1', date: '2026-09-22', km: 120 }],
  admins: [{ email: 'a1@ejemplo.test' }],
  log: new Map<string, Record<string, unknown>>(),
  emails: [] as Record<string, unknown>[],
}

function resetState() {
  state.log.clear()
  state.emails = []
  state.settings.weekly_report_enabled = true
  state.settings.weekly_report_day = 1
  state.settings.notification_emails = []
}

const server = Deno.serve({ port: PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  const single = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const one = (row: unknown) => single ? (row ? Response.json(row) : new Response(null, { status: 406 })) : Response.json(row ? [row] : [])

  if (url.pathname === '/resend/emails') {
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
    case '/rest/v1/vehicles':
      if (url.searchParams.get('active') !== 'eq.true') return new Response('falta active', { status: 400 })
      return Response.json(state.vehicles)
    case '/rest/v1/vehicle_odometer': return Response.json(state.odometers)
    case '/rest/v1/vehicle_daily_mileage': return Response.json(state.mileage)
    case '/rest/v1/profiles':
      if (url.searchParams.get('id') === 'eq.u-admin') return one({ role: 'admin', active: true })
      return Response.json(state.admins)
    case '/rest/v1/rpc/flota_claim_notification': {
      const { p_kind, p_date } = await req.json()
      const key = `${p_kind}:${p_date}`
      const row = state.log.get(key)
      if (row && row.status !== 'error') return Response.json(false)
      state.log.set(key, { kind: p_kind, local_date: p_date, status: 'sending' })
      return Response.json(true)
    }
    case '/rest/v1/reminder_log': {
      if (url.searchParams.get('on_conflict') !== 'kind,local_date') return new Response('on_conflict', { status: 400 })
      const body = await req.json()
      for (const row of Array.isArray(body) ? body : [body]) state.log.set(`${row.kind}:${row.local_date}`, row)
      return new Response(null, { status: 201 })
    }
  }
  return new Response('not found', { status: 404 })
})

const cron = () => new Request('http://f', { method: 'POST', headers: { 'x-cron-secret': 'secreto-de-prueba-123456' }, body: '{}' })
const at = (iso: string) => withErrors(createHandler({ now: () => new Date(iso) }))
const LUNES_0715 = '2026-09-28T11:15:00Z'  // 07:15 en UTC-4, lunes
const MARTES_0715 = '2026-09-29T11:15:00Z'

Deno.test({ name: 'flujo de send-weekly-report', sanitizeOps: false, sanitizeResources: false, async fn(t) {
  try {
    await t.step('antes de las 7:00 no hace nada', async () => {
      resetState()
      assertEquals((await (await at('2026-09-28T10:15:00Z')(cron())).json()).skipped, 'hour')
    })

    await t.step('otro día de la semana: not_today', async () => {
      resetState()
      assertEquals((await (await at(MARTES_0715)(cron())).json()).skipped, 'not_today')
      assertEquals(state.log.size, 0)
    })

    await t.step('desactivado: no reserva ni registra', async () => {
      resetState()
      state.settings.weekly_report_enabled = false
      assertEquals((await (await at(LUNES_0715)(cron())).json()).skipped, 'disabled')
      assertEquals(state.log.size, 0)
    })

    await t.step('el día configurado envía el reporte a los admins y lo registra', async () => {
      resetState()
      const res = await (await at(LUNES_0715)(cron())).json()
      assertEquals(res.status, 'sent')
      assertEquals(res.kind, 'weekly')
      assertEquals(state.emails[0].to, ['a1@ejemplo.test'])
      assertStringIncludes(String(state.emails[0].subject), 'reporte semanal — 21/09 al 27/09/2026')
      assertStringIncludes(String(state.emails[0].text), 'semana 120 km')
      assertEquals(state.log.get('weekly:2026-09-28')?.status, 'sent')
    })

    await t.step('no repite el mismo día', async () => {
      assertEquals((await (await at('2026-09-28T12:15:00Z')(cron())).json()).skipped, 'already_sent')
      assertEquals(state.emails.length, 1)
    })

    await t.step('día configurable: martes', async () => {
      resetState()
      state.settings.weekly_report_day = 2
      assertEquals((await (await at(MARTES_0715)(cron())).json()).status, 'sent')
    })

    await t.step('destinatarios configurados', async () => {
      resetState()
      state.settings.notification_emails = ['flota@ejemplo.test']
      await (await at(LUNES_0715)(cron())).json()
      assertEquals(state.emails[0].to, ['flota@ejemplo.test'])
    })

    await t.step('sin vehículos: nothing_to_send', async () => {
      resetState()
      const saved = state.vehicles
      state.vehicles = []
      const res = await (await at(LUNES_0715)(cron())).json()
      state.vehicles = saved
      assertEquals(res.status, 'nothing_to_send')
      assertEquals(state.emails.length, 0)
    })

    await t.step('prueba de un admin: cualquier día y hora, solo a quien la pide', async () => {
      resetState()
      const req = new Request('http://f', { method: 'POST', headers: { authorization: 'Bearer jwt-admin' }, body: '{"test":true}' })
      const res = await (await at(MARTES_0715)(req)).json()
      assertEquals(res.status, 'sent')
      assertEquals(state.emails[0].to, ['yo@ejemplo.test'])
      assertEquals(state.log.size, 0)
    })
  } finally {
    await server.shutdown()
  }
} })
```

Run: `cd supabase/functions && npx -y deno test --allow-net --allow-env _tests/send_weekly_report_test.ts`
Expected: FAIL (el módulo no existe).

- [ ] **Step 2: Handler e index**

`send-weekly-report/handler.ts`:

```ts
// send-weekly-report: resumen semanal de todos los vehículos activos.
//
// Modo programado (pg_cron, header x-cron-secret): el día configurado
// (fleet_settings.weekly_report_day, 1 = lunes), a partir de las 7:00 en
// APP_TIMEZONE, una vez. Cubre los 7 días anteriores. Ver _shared/notify.ts.
// Modo prueba (admin con sesión, body { test: true }): lo envía solo al admin
// que llama, cualquier día y hora, sin registrar.
import { json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin } from '../_shared/supabase.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { addDays, appTimeZone, dateInTz, hourInTz, isoWeekday } from '../_shared/time.ts'
import { buildWeeklyReport } from '../_shared/weekly_report.ts'
import { buildWeeklyEmail } from '../_shared/weekly_email.ts'
import { deliver, loadNotificationSettings, resendConfigured, SEND_HOUR } from '../_shared/notify.ts'

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
    if (!fromCron && !test) throw new HttpError(400, 'Usa { "test": true } para enviar un reporte de prueba.')

    const tz = appTimeZone()
    const now = deps.now()
    const today = dateInTz(now, tz)

    if (!test) {
      if (hourInTz(now, tz) < SEND_HOUR) return json({ skipped: 'hour', today })
      if (!resendConfigured()) return json({ skipped: 'not_configured', today })
    }

    const settings = await loadNotificationSettings(db)
    if (!test) {
      if (!settings.weekly_report_enabled) return json({ skipped: 'disabled', today })
      if (isoWeekday(today) !== settings.weekly_report_day) return json({ skipped: 'not_today', today })
    }

    let testRecipients: string[] | undefined
    if (test) {
      if (!caller?.user.email) throw new HttpError(400, 'Tu usuario no tiene correo; no se puede enviar la prueba.')
      testRecipients = [caller.user.email]
    }

    return deliver(db, {
      kind: 'weekly',
      today,
      test,
      testRecipients,
      configuredRecipients: settings.notification_emails,
      prepare: async () => {
        const [vRes, oRes, mRes] = await Promise.all([
          db.from('vehicles')
            .select('id, name, plate, active, next_maintenance_km, next_maintenance_date, insurance_company, insurance_expiry, gps_device_id, driver:profiles(full_name)')
            .eq('active', true),
          db.from('vehicle_odometer').select('vehicle_id, odometer_km, has_data'),
          db.from('vehicle_daily_mileage').select('vehicle_id, date, km').gte('date', addDays(today, -28)).lt('date', today),
        ])
        const err = vRes.error ?? oRes.error ?? mRes.error
        if (err) throw new HttpError(500, err.message)

        const report = buildWeeklyReport({ vehicles: vRes.data ?? [], odometers: oRes.data ?? [], mileage: mRes.data ?? [] }, settings, today)
        return {
          itemCount: report.rows.length,
          nothingToSend: report.rows.length === 0,
          render: cfg => buildWeeklyEmail(report, { ...cfg, weekday: settings.weekly_report_day }),
        }
      },
    })
  }
}
```

`send-weekly-report/index.ts`:

```ts
import { serve } from '../_shared/http.ts'
import { createHandler } from './handler.ts'

serve(createHandler())
```

Agregar al final de `supabase/config.toml`:

```toml

[functions.send-weekly-report]
verify_jwt = false
```

- [ ] **Step 3: Verificar**

Run:
```bash
cd supabase/functions
npx -y deno test --allow-net --allow-env _tests/
npx -y deno check send-weekly-report/index.ts send-reminders/index.ts sync-mileage/index.ts gps-status/index.ts create-user/index.ts
```
Expected: todo PASS.

Si el embed `driver:profiles(full_name)` no tipa con `WeeklyVehicle` (supabase-js puede inferir un array), convertirlo explícitamente al pasar los datos: `(vRes.data ?? []) as unknown as WeeklyVehicle[]`, importando el tipo. Reportar la desviación.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/send-weekly-report supabase/functions/_tests/send_weekly_report_test.ts supabase/config.toml
git commit -m "feat(functions): send-weekly-report, resumen semanal de la flota"
```

---

### Task 9: Frontend — Configuración reorganizada

**Files:**
- Modify: `src/lib/settings.ts`
- Modify (reescribir): `src/pages/settings/SettingsPage.tsx`

- [ ] **Step 1: `src/lib/settings.ts`**

Ampliar la interfaz, los defaults y las columnas; el resto del archivo no cambia:

```ts
export interface FleetSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
  email_reminders_enabled: boolean
  notification_emails: string[]
  weekly_report_enabled: boolean
  weekly_report_day: number // 1 = lunes … 7 = domingo
}

export const DEFAULT_SETTINGS: FleetSettings = {
  maintenance_km_threshold: 2000,
  maintenance_days_threshold: 15,
  insurance_days_threshold: 30,
  email_reminders_enabled: true,
  notification_emails: [],
  weekly_report_enabled: true,
  weekly_report_day: 1,
}

const COLUMNS = 'maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled, notification_emails, weekly_report_enabled, weekly_report_day'
```

Actualizar el comentario de la cabecera de la interfaz: "…los mismos valores usan send-reminders y send-weekly-report."

- [ ] **Step 2: Reescribir `src/pages/settings/SettingsPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Settings, Loader2, Mail, CalendarDays, Shield, Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { invokeFunction } from '@/lib/functions'
import { DEFAULT_SETTINGS, fetchFleetSettingsStrict, setFleetSettingsCache, type FleetSettings } from '@/lib/settings'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type NumberKey = 'maintenance_km_threshold' | 'maintenance_days_threshold' | 'insurance_days_threshold'

interface Form {
  numbers: Record<NumberKey, string>
  emails: string // un correo por línea (también se aceptan comas)
  dailyEnabled: boolean
  weeklyEnabled: boolean
  weeklyDay: number
}

const MAX: Record<NumberKey, number> = {
  maintenance_km_threshold: 1_000_000,
  maintenance_days_threshold: 3_650,
  insurance_days_threshold: 3_650,
}
const MAX_EMAILS = 50
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

function toForm(s: FleetSettings): Form {
  return {
    numbers: {
      maintenance_km_threshold: String(s.maintenance_km_threshold),
      maintenance_days_threshold: String(s.maintenance_days_threshold),
      insurance_days_threshold: String(s.insurance_days_threshold),
    },
    emails: s.notification_emails.join('\n'),
    dailyEnabled: s.email_reminders_enabled,
    weeklyEnabled: s.weekly_report_enabled,
    weeklyDay: s.weekly_report_day,
  }
}

function parseEmails(raw: string): string[] {
  return [...new Set(raw.split(/[\n,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))]
}

// Forma normalizada para comparar si hay cambios sin guardar.
function normalize(f: Form) {
  return JSON.stringify({ ...f, emails: parseEmails(f.emails) })
}

type Result = { ok: boolean; text: string } | null

export default function SettingsPage() {
  const [loaded, setLoaded] = useState<FleetSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [form, setForm] = useState<Form>(toForm(DEFAULT_SETTINGS))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<Result>(null)
  const [testing, setTesting] = useState<'daily' | 'weekly' | null>(null)
  const [testResult, setTestResult] = useState<{ kind: 'daily' | 'weekly'; result: Result } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchFleetSettingsStrict()
      .then(s => {
        if (cancelled) return
        setLoaded(s)
        setForm(toForm(s))
      })
      .catch(e => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [reloadKey])

  function handleRetry() {
    setLoaded(null)
    setLoadError(null)
    setReloadKey(k => k + 1)
  }

  function update(patch: Partial<Form>) {
    setMessage(null)
    setForm(f => ({ ...f, ...patch }))
  }

  const dirty = loaded != null && normalize(form) !== normalize(toForm(loaded))

  async function handleSave() {
    if (!loaded) return
    setMessage(null)
    const entries = Object.entries(form.numbers) as [NumberKey, string][]
    const invalid = entries.find(([key, v]) => {
      const n = Number(v)
      return !Number.isInteger(n) || n < 1 || n > MAX[key]
    })
    if (invalid) {
      setMessage({ ok: false, text: `Los umbrales deben ser números enteros entre 1 y ${MAX[invalid[0]]}.` })
      return
    }
    const emails = parseEmails(form.emails)
    const badEmail = emails.find(e => !EMAIL_RE.test(e))
    if (badEmail) {
      setMessage({ ok: false, text: `"${badEmail}" no es un correo válido.` })
      return
    }
    if (emails.length > MAX_EMAILS) {
      setMessage({ ok: false, text: `Máximo ${MAX_EMAILS} destinatarios.` })
      return
    }
    const values = {
      ...Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])) as Record<NumberKey, number>,
      notification_emails: emails,
      email_reminders_enabled: form.dailyEnabled,
      weekly_report_enabled: form.weeklyEnabled,
      weekly_report_day: form.weeklyDay,
    }
    setSaving(true)
    const { data, error } = await supabase.from('fleet_settings').update(values).eq('id', true).select('id')
    setSaving(false)
    if (error) {
      setMessage({ ok: false, text: error.message })
      return
    }
    if (!data || data.length === 0) {
      setMessage({ ok: false, text: 'No se guardó: no tienes permiso o la configuración no existe.' })
      return
    }
    let refreshed: FleetSettings
    try {
      refreshed = await fetchFleetSettingsStrict()
    } catch {
      // La escritura funcionó; si la relectura falla, usamos los valores guardados.
      refreshed = values
      setFleetSettingsCache(refreshed)
    }
    setLoaded(refreshed)
    setForm(toForm(refreshed))
    setMessage({ ok: true, text: 'Configuración guardada.' })
  }

  async function handleTest(kind: 'daily' | 'weekly') {
    setTesting(kind)
    setTestResult(null)
    try {
      const fn = kind === 'daily' ? 'send-reminders' : 'send-weekly-report'
      const res = await invokeFunction<{ items: number }>(fn, { test: true })
      const text = kind === 'daily'
        ? (res.items > 0
          ? `Correo enviado a tu dirección con ${res.items} alerta${res.items === 1 ? '' : 's'} de mantenimiento.`
          : 'Correo enviado a tu dirección (hoy no hay mantenimientos por vencer).')
        : `Reporte enviado a tu dirección con ${res.items} vehículo${res.items === 1 ? '' : 's'}.`
      setTestResult({ kind, result: { ok: true, text } })
    } catch (e) {
      setTestResult({ kind, result: { ok: false, text: e instanceof Error ? e.message : String(e) } })
    } finally {
      setTesting(null)
    }
  }

  const numberField = (key: NumberKey, label: string, suffix: string, help: string) => {
    const helpId = `${key}-help`
    return (
      <div className="space-y-1">
        <Label htmlFor={key}>{label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={key}
            type="number"
            min={1}
            max={MAX[key]}
            step={1}
            className="w-32"
            value={form.numbers[key]}
            aria-describedby={helpId}
            onChange={e => update({ numbers: { ...form.numbers, [key]: e.target.value } })}
          />
          <span className="text-sm text-muted-foreground">{suffix}</span>
        </div>
        <p id={helpId} className="text-xs text-muted-foreground">{help}</p>
      </div>
    )
  }

  const testButton = (kind: 'daily' | 'weekly', label: string) => (
    <div className="space-y-1">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="outline" size="sm" onClick={() => handleTest(kind)} disabled={testing != null || dirty}>
          {testing === kind ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Enviando...</> : label}
        </Button>
        {dirty && <p className="text-sm text-muted-foreground">Guarda los cambios para probar con la nueva configuración.</p>}
        {testResult?.kind === kind && testResult.result && (
          <p role="status" aria-live="polite" className={`text-sm ${testResult.result.ok ? 'text-green-700' : 'text-red-600'}`}>
            {testResult.result.text}
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">La prueba se envía solo a tu correo y usa la configuración guardada.</p>
    </div>
  )

  const checkbox = (checked: boolean, onChange: (v: boolean) => void, label: string, help: string) => (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="text-sm">
        {label}
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
    </label>
  )

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Settings size={22} />
          Configuración
        </h1>
        <p className="text-sm text-muted-foreground">Correos de la flota: destinatarios, alertas diarias y reporte semanal</p>
      </div>

      {loadError ? (
        <div className="text-center py-12 space-y-3">
          <p className="text-sm text-red-600" role="status" aria-live="polite">
            No se pudo cargar la configuración. {loadError}
          </p>
          <Button variant="outline" size="sm" onClick={handleRetry}>Reintentar</Button>
        </div>
      ) : !loaded ? (
        <p className="text-sm text-muted-foreground text-center py-12">Cargando...</p>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6 space-y-3">
              <h2 className="font-medium flex items-center gap-2"><Users size={16} /> Destinatarios de los correos</h2>
              <Label htmlFor="notification_emails" className="sr-only">Destinatarios</Label>
              <textarea
                id="notification_emails"
                rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={'flota@tu-empresa.com\njefe.taller@tu-empresa.com'}
                value={form.emails}
                aria-describedby="notification_emails-help"
                onChange={e => update({ emails: e.target.value })}
              />
              <p id="notification_emails-help" className="text-xs text-muted-foreground">
                Un correo por línea (hasta {MAX_EMAILS}). Reciben las alertas diarias y el reporte semanal. Si lo dejas vacío, se envían a los administradores activos.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium flex items-center gap-2"><Mail size={16} /> Alertas diarias de mantenimiento</h2>
              {checkbox(form.dailyEnabled, v => update({ dailyEnabled: v }), 'Enviar alertas diarias',
                'Se envían a partir de las 7:00 (hora local) solo si hay mantenimientos por vencer o vencidos, y se repiten cada día hasta que se actualice el dato.')}
              {numberField('maintenance_km_threshold', 'Avisar por kilometraje', 'km antes',
                'La tarjeta pasa a "Próximo pronto" y se incluye en la alerta.')}
              {numberField('maintenance_days_threshold', 'Avisar por fecha', 'días antes',
                'Para vehículos con fecha de próximo mantenimiento.')}
              {testButton('daily', 'Probar alerta diaria')}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium flex items-center gap-2"><CalendarDays size={16} /> Reporte semanal</h2>
              {checkbox(form.weeklyEnabled, v => update({ weeklyEnabled: v }), 'Enviar el reporte semanal',
                'Resumen de todos los vehículos de los últimos 7 días. Se envía a partir de las 7:00 (hora local) del día elegido.')}
              <div className="space-y-1">
                <Label htmlFor="weekly_report_day">Día de envío</Label>
                <select
                  id="weekly_report_day"
                  className="block w-48 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.weeklyDay}
                  onChange={e => update({ weeklyDay: Number(e.target.value) })}
                >
                  {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                </select>
              </div>
              {testButton('weekly', 'Probar reporte semanal')}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-5">
              <h2 className="font-medium flex items-center gap-2"><Shield size={16} /> Seguro</h2>
              {numberField('insurance_days_threshold', 'Avisar vencimiento del seguro', 'días antes',
                'Alerta en la tarjeta y en el reporte semanal.')}
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-3">
            {message && (
              <p role="status" aria-live="polite" className={`text-sm ${message.ok ? 'text-green-700' : 'text-red-600'}`}>
                {message.text}
              </p>
            )}
            <Button onClick={handleSave} disabled={saving || !dirty}>
              {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</> : 'Guardar'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verificar y commit**

Run: `npm run lint && npm run build`
Expected: sin errores.

```bash
git add src/lib/settings.ts src/pages/settings/SettingsPage.tsx
git commit -m "feat(web): configuración de destinatarios, alertas diarias y reporte semanal"
```

---

### Task 10: Documentación

**Files:**
- Modify: `docs/INSTALACION.md`, `README.md`

- [ ] **Step 1: `docs/INSTALACION.md`**

1. **Conteos:** las funciones pasan a ser 5 (sumar `send-reminders` y `send-weekly-report` donde se listan). Buscar con `grep -n "4 funciones\|cuatro funciones\|send-reminders" docs/INSTALACION.md` y actualizar la lista, la cantidad y el checklist.
2. **Paso 8:** donde se listan los jobs (tabla o texto), agregar `flota-reporte-semanal`: cada hora, minuto 15, envía el reporte semanal el día configurado.
3. **Paso 9:** retitularlo "## 9. Correos: alertas diarias y reporte semanal (opcional)" y reescribir la introducción:

   > Flota Admin envía dos correos a la **lista de destinatarios** de Configuración (si está vacía, a los administradores activos):
   >
   > - **Alerta diaria de mantenimiento:** a partir de las 7:00 (hora de `APP_TIMEZONE`), solo si hay mantenimientos por km o por fecha por vencer o vencidos. Los avisos por km incluyen los días estimados según el uso de los últimos 28 días (vehículos con GPS). Se repite cada día hasta que se actualice el mantenimiento en la app.
   > - **Reporte semanal:** el día elegido (lunes por defecto), a partir de las 7:00. Resume todos los vehículos: odómetro, km de la semana, próximo mantenimiento, seguro y alertas.

   En el paso de la app (punto 3): "entra a **Configuración**, carga los destinatarios, elige el día del reporte y usa **Probar alerta diaria** y **Probar reporte semanal**".

   Reemplazar la consulta SQL de `reminder_log` por:

   ```sql
   select kind, local_date, status, item_count, recipients, error
   from public.reminder_log
   order by local_date desc, kind
   limit 20;
   ```

   En la tabla de estados:
   - agregar una fila con `kind`: `daily` es la alerta diaria y `weekly` el reporte semanal;
   - en la fila de `disabled`: "Registros anteriores; ya no se registra (si el correo está desactivado, no se reserva el día)".
4. **Lista de verificación:** reemplazar la línea del correo por "(Correo) La alerta diaria y el reporte semanal de prueba llegan desde **Configuración** (paso 9)."

- [ ] **Step 2: `README.md`**

Reemplazar la línea de "Recordatorios por correo" por:

```markdown
- **Correos a la flota:** alerta diaria cuando un mantenimiento (por km o por fecha) está por vencer, con los días estimados según el uso, y un reporte semanal con el estado de todos los vehículos. Destinatarios, umbrales y día del reporte se configuran desde la app.
```

- [ ] **Step 3: Commit**

Verificar que las marcas de bloque de código queden balanceadas (`grep -c '^```' docs/INSTALACION.md` debe dar un número par).

```bash
git add docs/INSTALACION.md README.md
git commit -m "docs: alertas diarias de mantenimiento, reporte semanal y destinatarios"
```

---

### Task 11: Verificación en el proyecto de prueba

La hace el coordinador junto con el usuario (los secrets de Resend ya están cargados).

- [ ] **Step 1: Suite completa**

```bash
npm run lint
npm run build
npm run test:db
cd supabase/functions
npx -y deno test --allow-net --allow-env _tests/
```

- [ ] **Step 2: Migración y deploy (en este orden y seguidos)**

La migración elimina `flota_claim_reminder_day`, así que la función vieja falla hasta redesplegarla.

```bash
cat supabase/.temp/project-ref                   # oklpfxskdujpaqxnwvbf
npx -y supabase@latest db push
npx -y supabase@latest functions deploy --use-api
```

- [ ] **Step 3: Pruebas desde la app (usuario)**

1. En Configuración, cargar un destinatario, elegir el día y guardar.
2. Pulsar **Probar alerta diaria** y **Probar reporte semanal**. Revisar los dos correos.

- [ ] **Step 4: Programados forzados (SQL)**

1. Poner `weekly_report_day` en el día de hoy.
2. Ejecutar `select public.flota_request_reminders(); select public.flota_request_weekly_report();`.
3. Revisar `net._http_response` y `reminder_log`: tienen que aparecer las dos filas (`daily` y `weekly`) en `sent`, en el mismo día.
4. Una segunda llamada de cada una debe devolver `already_sent`.

- [ ] **Step 5: Merge**

Merge `--no-ff` de `feature/reporte-semanal` a `main` y push.
