# Reporte semanal, alerta diaria de mantenimiento y destinatarios — Diseño

**Fecha:** 2026-09-27
**Estado:** aprobado
**Parte de:** los recordatorios por correo (`2026-09-26-recordatorios-email-design.md`, ya en `main`)

## Objetivo

1. **Alerta diaria (acción).** Sale solo cuando algún **mantenimiento** está cerca de vencer, por km o por fecha, o ya venció, para que alguien actúe. Si no hay nada que atender, no se envía. Los avisos por km muestran los **días estimados** según el ritmo de uso.
2. **Reporte semanal (resumen).** Un correo con el estado de **todos los vehículos activos**: odómetro, km de la semana, próximo mantenimiento, seguro y las alertas. Sale el día de la semana que se configure.
3. **Destinatarios configurables.** Una lista de correos compartida por los dos envíos. Si está vacía, se envía a los administradores activos.

## Decisiones

| Tema | Decisión |
|---|---|
| Contenido del diario | Solo mantenimiento (km y fecha). El seguro sale del diario y pasa al semanal. |
| Estimación de días | Promedio de km por día de los últimos 28 días (`vehicle_daily_mileage`). Se estima si el vehículo tiene GPS, al menos 7 días con registro y promedio > 0. No se estima en los vencidos. |
| Día del semanal | Configurable: `weekly_report_day` de 1 (lunes) a 7 (domingo), lunes por defecto. Sale a partir de las 7:00 en `APP_TIMEZONE`. |
| Período del semanal | Los 7 días completos anteriores al día de envío: de `hoy − 7` a `hoy − 1`. |
| Destinatarios | `fleet_settings.notification_emails` (`text[]`). Si está vacía, se usan los admins activos. La misma lista sirve para los dos correos. |
| Arquitectura | Dos funciones (`send-reminders` y `send-weekly-report`) que comparten el flujo en `_shared/notify.ts`. |

## Datos (migración `…0700_reporte_semanal.sql`)

### `fleet_settings`, columnas nuevas

| Columna | Tipo | Default |
|---|---|---|
| `notification_emails` | `text[] not null` | `'{}'` |
| `weekly_report_enabled` | `boolean not null` | `true` |
| `weekly_report_day` | `smallint not null`, `check (between 1 and 7)` | `1` |

- **Validación de correos:** una función `public.flota_valid_emails(text[]) returns boolean` (immutable), usada en un `check`.
  - Cada elemento debe cumplir `^[^\s@]+@[^\s@]+\.[^\s@]+$`.
  - La lista tiene como máximo 50 elementos, porque Resend no acepta más de 50 destinatarios en `to`.
- Ninguna política cambia: los usuarios activos leen la tabla y solo el admin la edita. Los privilegios por columna tampoco cambian: el admin actualiza cualquier columna, salvo `id`.

### `reminder_log`

- Nueva columna `kind text not null default 'daily' check (kind in ('daily', 'weekly'))`.
- La unicidad pasa de `unique (local_date)` a `unique (kind, local_date)`: se elimina la constraint existente y se crea la nueva.
- **La reserva recibe el tipo:** `public.flota_claim_notification(p_kind text, p_date date) returns boolean`, con la misma semántica de `flota_claim_reminder_day`. Devuelve `true` solo si la fila `(kind, fecha)` no existía o estaba en `error`, y la deja en `sending`. Es `security definer`, con `search_path` vacío y ejecución solo para `service_role`.
- `flota_claim_reminder_day(date)` se **elimina**. En el mismo cambio, `send-reminders` pasa a usar la función nueva con `'daily'`.

### Cron

- `public.flota_request_weekly_report()`: igual que `flota_request_reminders()`, pero hace el POST a `/functions/v1/send-weekly-report`. Usa los mismos secretos de Vault.
- Job **`flota-reporte-semanal`**, `'15 * * * *'`. La función decide si hoy corresponde enviar.

## Flujo compartido (`_shared/notify.ts`)

```ts
type NotificationKind = 'daily' | 'weekly'

// Destinatarios: la lista configurada o, si está vacía, los admins activos.
resolveRecipients(db, settings): Promise<string[]>

// Envío programado: reserva, arma el contenido, envía y registra.
runScheduled(db, {
  kind, today,
  build: () => Promise<{ skip?: 'nothing_to_send'; email?: EmailContent; itemCount: number }>,
}): Promise<Response>
```

`runScheduled` concentra la máquina de estados que hoy está en `send-reminders`:

1. **Reserva** el día con `flota_claim_notification(kind, today)`. Si devuelve `false`, responde `{skipped: 'already_sent'}`.
2. **Todo lo que falle antes de enviar** (lectura de datos, `build`, destinatarios, configuración de correo) registra `error` y se reintenta la hora siguiente.
3. **`build` devuelve `skip: 'nothing_to_send'`:** registra `nothing_to_send` y no envía.
4. **Envío:**
   - un `ResendHttpError` registra `error` (se reintenta);
   - un error de red o timeout, con el envío ya intentado, registra `sending` ("posiblemente enviado"; no se reintenta);
   - si sale bien, registra `sent`. Este registro es best-effort: si falla, no se reenvía.
5. Todas las filas de `reminder_log` llevan su `kind`.

Las comprobaciones previas las hace cada función **antes** de llamar a `runScheduled`:
- secreto del cron;
- `RESEND_API_KEY` vacío → `not_configured`;
- hora antes de las 7:00 → `hour`;
- interruptor apagado → `{skipped: 'disabled'}`, sin reservar ni registrar. Así, si se reactiva más tarde ese mismo día, el envío sale en la hora siguiente. El estado `disabled` de `reminder_log` deja de usarse, aunque se mantiene en el `check` por los registros existentes;
- en el semanal, que hoy sea el día configurado → si no, `{skipped: 'not_today'}`.

## Alerta diaria (`send-reminders`)

- **Cálculo:** `computeReminders` deja de producir el tipo `insurance`. Quedan `maintenance_km` y `maintenance_date`, con las mismas reglas de umbral y vencimiento. El tipo `insurance` y su cálculo pasan a `_shared/weekly_report.ts`.
- **Días estimados:** una función pura en `_shared/reminders.ts`.

  ```ts
  averageKmPerDay(rows: { date: string; km: number }[], today: string): number | null
  // últimos 28 días: de today−28 a today−1
  // null si hay menos de 7 días con registro o si el promedio es ≤ 0
  ```

  - El promedio es la suma de km dividida entre **28**: los días sin registro cuentan como 0 km, porque el vehículo no se movió.
  - Los días con registro se usan solo como umbral de confianza.
  - `ReminderItem` suma `estimatedDays?: number` (`Math.ceil(remaining / promedio)`), solo en `maintenance_km` no vencidos con promedio disponible.
- **Datos:** además de `vehicles` y `vehicle_odometer`, lee `vehicle_daily_mileage` de los últimos 28 días de los vehículos con GPS, en una sola consulta.
- **Correo** (`reminder_email.ts`):
  - Asunto: `"{APP_NAME}: {n} alerta(s) de mantenimiento — {dd/mm/aaaa}"`.
  - Texto de km con estimación: `"faltan 700 km (≈ 7 días al ritmo actual; a los 126.500 km)"`. Si faltara menos de un día, `"≈ 1 día"`. Sin estimación, el texto queda como hoy.
  - El pie cambia a: "Recibes este aviso porque estás en la lista de avisos de la flota. Se repite cada día hasta que se actualice el mantenimiento en la app."

## Reporte semanal (`send-weekly-report`, nuevo)

### Datos
Se leen con el service role:
- `fleet_settings`;
- vehículos activos: `id, name, plate, next_maintenance_km, next_maintenance_date, insurance_company, insurance_expiry, gps_device_id`, más `driver:profiles(full_name)`;
- `vehicle_odometer`;
- `vehicle_daily_mileage` del período.

### Cálculo (módulo puro `_shared/weekly_report.ts`)

```ts
interface WeeklyVehicleRow {
  vehicleId: string; name: string; plate: string | null; driver: string | null
  odometerKm: number | null        // null si has_data = false
  weekKm: number | null            // null si no tiene GPS
  maintenance: { kind: 'km'; remainingKm: number } | { kind: 'date'; remainingDays: number; date: string } | null
  insurance: { expiry: string; remainingDays: number; company: string | null } | null
  alerts: ReminderItem[]           // mantenimiento (reglas del diario) + seguro (umbral de seguro)
}

buildWeeklyReport(input, settings, today): {
  periodFrom: string; periodTo: string
  totals: { vehicles: number; weekKm: number; alerts: number }
  attention: ReminderItem[]        // todas las alertas, ordenadas como el diario (vencidos primero)
  rows: WeeklyVehicleRow[]         // ordenados por nombre
}
```

- **`maintenance` en la tabla:** se muestra el criterio más cercano.
  - Si tiene los dos, se muestra el de km, salvo que el de fecha esté vencido o dentro de su umbral y el de km no.
  - Si no tiene ninguno, `null`.
- **Seguro en las alertas:** vencido si faltan ≤ 0 días; próximo si faltan ≤ `insurance_days_threshold`. Es la misma regla que tenía el diario.
- **`weekKm`:** suma de `vehicle_daily_mileage` entre `hoy−7` y `hoy−1` (vehículos con GPS).
- **`totals.weekKm`:** suma de las `weekKm` no nulas.

### Correo (módulo puro `_shared/weekly_email.ts`)
- **Asunto:** `"{APP_NAME}: reporte semanal — {dd/mm} al {dd/mm/aaaa}"`.
- **Secciones:**
  1. **Resumen:** vehículos activos, km recorridos por la flota y cantidad de alertas.
  2. **Requieren atención:** tabla de vencidos y próximos, con el mismo formato que el diario más el seguro. Si no hay alertas: "Sin alertas esta semana."
  3. **Vehículos:** tabla con Vehículo (placa), Conductor, Odómetro, Km semana, Próx. mantenimiento y Seguro.
     - "—" si falta el dato; "sin GPS" en Km semana.
     - El mantenimiento y el seguro muestran "faltan X km", "en X días (dd/mm)" o "vencido…", en rojo o ámbar según el estado.
  4. **Botón** "Abrir {APP_NAME}", que apunta a `APP_URL/vehiculos`.
  5. **Pie:** "Reporte semanal de la flota. Se envía cada {día} a la lista de avisos."
- **Versión de texto plano** con el mismo contenido. Todo el contenido que viene de la base se escapa en el HTML.
- Si no hay vehículos activos, el semanal registra `nothing_to_send` y no envía.

### Modo prueba
- Un admin con sesión llama con `{test: true}`.
- Se envía **solo al admin que llama**, ignorando la hora, el día, el interruptor y el registro. Mismo comportamiento que en el diario.

## Frontend: Configuración

La página se reorganiza en tarjetas:

1. **Destinatarios de los correos.**
   - Un `textarea`, con un correo por línea (también se aceptan comas).
   - Validación en el cliente con el mismo regex y hasta 50 correos.
   - Ayuda: "Si lo dejas vacío, se envían a los administradores activos."
2. **Alertas diarias de mantenimiento.**
   - El interruptor (`email_reminders_enabled`) y los umbrales de km y días.
   - El botón **"Probar alerta diaria"**.
   - Ayuda: "Se envía a partir de las 7:00 (hora local) solo si hay mantenimientos por vencer o vencidos. Se repite cada día hasta que se actualice el dato."
3. **Reporte semanal.**
   - El interruptor (`weekly_report_enabled`), el día (un `select` de lunes a domingo) y el botón **"Probar reporte semanal"**.
   - Ayuda: "Resumen de todos los vehículos de los últimos 7 días. Se envía a partir de las 7:00 (hora local) del día elegido."
4. **Seguro:** `insurance_days_threshold`, con la ayuda "Alerta en la tarjeta y en el reporte semanal."

Se mantiene todo lo ya resuelto en la página:
- la carga estricta;
- Guardar deshabilitado sin cambios;
- las pruebas deshabilitadas con cambios sin guardar;
- la comprobación de que el guardado afectó una fila;
- `aria-live`.

`FleetSettings` y `DEFAULT_SETTINGS` (`src/lib/settings.ts`) suman los tres campos nuevos.

## Pruebas

- **PGlite:**
  - columnas nuevas y defaults;
  - `check` de correos: rechaza uno inválido y más de 50;
  - `unique (kind, local_date)`;
  - `flota_claim_notification`: los tipos son independientes, y `authenticated` no puede ejecutarla;
  - job `flota-reporte-semanal`, y `flota_request_weekly_report()` sin secretos → `null`.
- **Deno:**
  - `averageKmPerDay`: menos de 7 días → `null`; promedio 0 → `null`; días sin registro cuentan como 0.
  - `estimatedDays` en `computeReminders`.
  - El diario ya no incluye el seguro.
  - `buildWeeklyReport`: período, totales, `weekKm` nulo sin GPS, elección de `maintenance`, alertas de seguro.
  - `buildWeeklyEmail`: asunto, secciones, "Sin alertas esta semana", escape de HTML y texto plano.
  - `resolveRecipients`: la lista, o los admins si está vacía.
  - `runScheduled`: se migran los pasos actuales de `send_reminders_test.ts` y el test nuevo del semanal cubre `not_today`, `disabled`, `already_sent`, `sent`, `nothing_to_send`, `error` con reintento y el modo prueba.
- **Proyecto de prueba:**
  - migración y deploy;
  - con destinatarios configurados, la prueba diaria y la semanal desde Configuración;
  - un envío programado forzado de cada tipo;
  - verificar que los dos pueden salir el mismo día sin bloquearse.

## Documentación

- **`INSTALACION.md` (paso 9):**
  - aclarar en la tabla de estados que `disabled` ya no se registra;
  - los dos correos y los destinatarios;
  - el job nuevo;
  - la tabla de estados con `kind` y la consulta de `reminder_log` agrupada por tipo.
- **README:** actualizar la línea de recordatorios: alertas diarias de mantenimiento, reporte semanal y destinatarios configurables.

## Fuera de alcance

Listas de destinatarios separadas por tipo, adjuntos (PDF o Excel), historial de reportes en la app, hora de envío configurable y estimación de días para los vehículos sin GPS.
