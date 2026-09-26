# Recordatorios por correo de vencimientos — Diseño

**Fecha:** 2026-09-26
**Estado:** aprobado

## Objetivo

Todos los días a las 7:00, en la zona horaria de la instalación, enviar a los administradores activos un único correo con los vencimientos de la flota:

- mantenimiento próximo o vencido, por km y por fecha;
- seguro próximo a vencer o vencido.

El aviso se repite cada día mientras la condición siga, y deja de aparecer solo cuando el admin actualiza el dato en la app.

## Decisiones

| Tema | Decisión |
|---|---|
| Servicio de correo | Resend (API HTTP). Cada instalación usa su propia cuenta y dominio verificado. Los puertos SMTP 25 y 587 están bloqueados en las edge functions. |
| Destinatarios | Todos los perfiles con `role = 'admin'` y `active = true`. Un solo correo por día. |
| Umbrales | Configurables por instalación y guardados en la base (`fleet_settings`). La app y el correo leen los mismos valores. Por defecto: 2.000 km y 15 días para mantenimiento, y 30 días para el seguro. |
| Hora | A partir de las 7:00 en `APP_TIMEZONE` (fija). Si falla, se reintenta cada hora ese mismo día. |
| Vencidos | Siempre se incluyen, sin importar el umbral. |
| Repetición | Sin estado por aviso: se recalcula cada día desde cero. |

## Datos (migración `…0600_recordatorios.sql`)

### `fleet_settings` (una sola fila)

| Columna | Tipo | Default |
|---|---|---|
| `id` | `boolean` PK, `check (id)` | `true` |
| `maintenance_km_threshold` | `integer`, `check (> 0)` | `2000` |
| `maintenance_days_threshold` | `integer`, `check (> 0)` | `15` |
| `insurance_days_threshold` | `integer`, `check (> 0)` | `30` |
| `email_reminders_enabled` | `boolean` | `true` |
| `updated_at` | `timestamptz` | `now()` |

- La migración inserta la única fila.
- RLS: `select` para cualquier usuario autenticado; `update` solo para el admin (`is_admin()`).
- Sin `insert` ni `delete` desde la API. `anon` no tiene acceso.

### `reminder_log`

| Columna | Tipo |
|---|---|
| `id` | `uuid` PK |
| `local_date` | `date`, **unique** (un envío programado por día) |
| `status` | `text`, `check in ('sent', 'nothing_to_send', 'disabled', 'error')` |
| `recipients` | `text[]` |
| `item_count` | `integer` |
| `error` | `text` |
| `created_at` | `timestamptz` |

- RLS activada y sin políticas: solo la usa el service role.
- Los envíos de prueba **no** se registran aquí, así que no bloquean el envío programado.
- Si el día quedó registrado como `error`, la siguiente ejecución horaria de ese mismo día reintenta y actualiza la fila.

### Vista `vehicle_odometer` (`security_invoker = true`)

Devuelve `vehicle_id`, `odometer_km`, `source` (`'gps' | 'manual'`), `from_log` y `has_data`, con la misma regla que hoy usa `useOdometer`:

- **Con GPS** (`gps_device_id` no nulo): `odometer_offset + Σ vehicle_daily_mileage.km`.
- **Sin GPS:** `greatest(odometer_offset, última vehicle_log.odometer_km no nula)`, ordenando por `date desc, created_at desc`.

Como es `security_invoker`, respeta la RLS de quien la consulta: el conductor solo ve su vehículo.

El frontend reemplaza las dos consultas de `useOdometer` por una lectura de esta vista. Así el correo y la tarjeta muestran exactamente el mismo número.

## Lógica de avisos (módulo puro `_shared/reminders.ts`)

```ts
type ReminderKind = 'maintenance_km' | 'maintenance_date' | 'insurance'

interface ReminderItem {
  vehicleId: string
  vehicleName: string
  plate: string | null
  kind: ReminderKind
  overdue: boolean
  remaining: number        // km o días; negativo si está vencido
  dueDate?: string         // YYYY-MM-DD (tipos de fecha)
  dueKm?: number           // maintenance_km
}

computeReminders(vehicles, odometers, settings, today): ReminderItem[]
```

Reglas, solo para vehículos **activos**:

| Tipo | Condición | `remaining` | `overdue` |
|---|---|---|---|
| Mantenimiento por km | `next_maintenance_km` no nulo y `next_maintenance_km − odometer_km ≤ umbral_km` | km restantes | `≤ 0` |
| Mantenimiento por fecha | `next_maintenance_date` no nula y días hasta la fecha `≤ umbral_días` | días restantes | `< 0` |
| Seguro | `insurance_expiry` no nula y días hasta la fecha `≤ umbral_seguro` | días restantes | `≤ 0` |

- Un vehículo sin GPS y sin odómetro (`has_data = false`) no genera aviso de mantenimiento por km.
- "Hoy" es la fecha en `APP_TIMEZONE`. Los días son diferencias de calendario, sin horas.
- Alineado con la tarjeta: el seguro que vence hoy (0 días) cuenta como **vencido**, igual que en la UI.
- Orden del resultado: primero los vencidos (los más atrasados antes) y luego los próximos (los más cercanos antes).

## Edge function `send-reminders`

`verify_jwt = false`. Tiene dos modos:

1. **Programado.** Lo llama pg_cron con el header `x-cron-secret` igual a `SYNC_CRON_SECRET`, con el body `{}`.
   1. Si la hora local en `APP_TIMEZONE` es anterior a las 7:00, responde `{skipped: 'hour'}`.
   2. Si ya hay una fila en `reminder_log` para hoy con un estado distinto de `error`, responde `{skipped: 'already_sent'}`. Así se envía una sola vez, en la primera ejecución desde las 7:00 (la de las 7:10), y si esa falla se reintenta a las 8:10, 9:10, etc.
   3. Si `email_reminders_enabled = false`, registra `disabled` y termina.
   4. Calcula los avisos. Si no hay ninguno, registra `nothing_to_send` y no envía correo.
   5. Si hay avisos, envía un correo a todos los admins activos (varios destinatarios en `to`) y registra `sent` o `error`.
2. **Prueba.** Un admin con sesión llama con `{test: true}`.
   - Envía los avisos de hoy **solo al admin que llama**, aunque no haya ninguno (en ese caso, un correo que lo indica).
   - Ignora la hora, el interruptor de activación y el registro.
   - Responde `{sent: true, items: n}` o el error de Resend.

Errores:
- Si faltan `RESEND_API_KEY`, `EMAIL_FROM` o `APP_URL`, responde 500 con un mensaje claro, y el envío programado queda registrado como `error`.
- Si Resend responde con error, se registra como `error` con su mensaje. La siguiente ejecución horaria reintenta, hasta que salga o termine el día; cada intento actualiza la misma fila.
- **Nunca se envían dos correos el mismo día:** la fila se crea o actualiza con `local_date` único, y solo se envía si no hay una fila en estado final.

## Correo (módulo puro `_shared/reminder_email.ts`)

- **Asunto:** `"{APP_NAME}: {n} vencimiento(s) — {dd/mm/aaaa}"`. `APP_NAME` es un secret opcional; por defecto, "Flota Admin".
- **HTML simple con estilos inline** (compatible con clientes de correo):
  - sección **"Vencidos"** en rojo y sección **"Próximos"** en ámbar;
  - una fila por aviso: vehículo, placa, tipo en español ("Mantenimiento (km)", "Mantenimiento (fecha)", "Seguro") y el detalle ("faltan 850 km", "vencido hace 3 días", "vence el 03/10/2026");
  - un botón "Abrir {APP_NAME}" que apunta a `APP_URL/vehiculos`;
  - un pie: "Recibes este aviso porque eres administrador. Se repite cada día hasta que se actualice el dato en la app."
- **Versión de texto plano** con el mismo contenido.
- Todo el contenido que viene de la base se escapa en el HTML.

## Cron (en la misma migración)

- **Job `flota-recordatorios`**, `'10 * * * *'`: llama a `public.flota_request_reminders()`.
- Esa función lee `flota_project_url` y `flota_sync_secret` de Vault, igual que `flota_request_mileage_sync`, y hace `net.http_post` a `/functions/v1/send-reminders`.
- Tiene `revoke execute` para `public`, `anon` y `authenticated`.

## Frontend

- **`src/lib/settings.ts`:** un hook `useFleetSettings()` que lee `fleet_settings` una vez por sesión, con los defaults del diseño como respaldo.
- **Página `/configuracion`** (solo admin; ítem "Configuración" en el menú):
  - los tres umbrales, con campos numéricos que validan valores > 0;
  - el interruptor "Enviar recordatorios diarios por correo";
  - el botón **"Enviar correo de prueba"**, que invoca `send-reminders` con `{test: true}` y muestra el resultado o el error;
  - un texto de ayuda: "Se envían a las 7:00 a todos los administradores activos."
- **Tarjeta de vehículo:**
  - Barra de mantenimiento:
    - ámbar si faltan ≤ umbral de km;
    - rojo si está vencido o faltan ≤ ⌈umbral/3⌉ km (con 2.000 queda en 667; hoy es 700);
    - verde en otro caso.
  - Nueva alerta de **mantenimiento por fecha**, con el mismo estilo que la del seguro: aparece si faltan ≤ umbral de días o ya venció.
  - Alerta de seguro: usa el umbral configurado en lugar del 30 fijo.
- **`useOdometer`:** lee de la vista `vehicle_odometer`.

## Secrets nuevos (`supabase/functions/.env.example`)

| Secret | Obligatorio | Ejemplo |
|---|---|---|
| `RESEND_API_KEY` | Sí, para los correos | `re_…` |
| `EMAIL_FROM` | Sí | `Flota <avisos@tu-empresa.com>` (dominio verificado en Resend) |
| `APP_URL` | Sí | `https://flota.tu-empresa.com` |
| `APP_NAME` | No | `Transportes Ejemplo` |

## Pruebas

- **Deno:**
  - `computeReminders`: umbrales exactos (en el límite y un valor más), vencidos, vehículos sin datos, vehículos inactivos excluidos, y orden.
  - Días en `APP_TIMEZONE`, incluido un cambio de día cerca de la medianoche.
  - Armado del correo: asunto, secciones, escape de HTML y texto plano.
- **Flujo contra servidor simulado:** PostgREST + Resend, cubriendo los envíos programados (`hour`, `already_sent`, `disabled`, `nothing_to_send`, `sent`, `error`) y el envío de prueba.
- **PGlite:**
  - RLS de `fleet_settings` (el conductor lee pero no edita) y de `reminder_log` (inaccesible).
  - `vehicle_odometer` para GPS y manual, y que respeta la RLS del conductor.
- **Proyecto de prueba:** migración, deploy, secrets de Resend (los provee el usuario), envío de prueba desde la pantalla de Configuración y una ejecución programada forzada.

## Documentación

- **`INSTALACION.md`:** paso nuevo "Configurar los recordatorios por correo" (cuenta de Resend, dominio, secrets, prueba) y verificación del job en el paso del cron.
- **`README.md`:** la funcionalidad en la lista.
- **`ACTUALIZACION.md`:** sin cambios de proceso, pero las notas de la versión deben mencionar los secrets nuevos.

## Fuera de alcance

Avisos al conductor, WhatsApp o SMS, silenciar un vehículo puntual, hora de envío configurable y un historial de envíos visible en la app.
