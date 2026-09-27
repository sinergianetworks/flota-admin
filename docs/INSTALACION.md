# Instalación

Esta guía instala Flota Admin desde cero:

- el **backend** en un proyecto nuevo de Supabase Cloud;
- el **frontend** en tu servidor, con Docker o Easypanel.

Tiempo estimado: 30–45 minutos.

## Requisitos

- Una cuenta en [supabase.com](https://supabase.com).
- En tu computadora: `git`, **Node.js 20 o superior** (para ejecutar el CLI de Supabase con `npx`) y `openssl`.
- Un servidor con Docker, o una instancia de Easypanel, para el frontend.
- Opcional: una cuenta de desarrollador de un proveedor GPS compatible (hoy, Tracksolid Pro).

No hace falta instalar el CLI de Supabase: todos los comandos usan `npx supabase@latest …`. Tampoco hace falta Docker en tu computadora.

Clona el repositorio. Todos los comandos se ejecutan desde la carpeta del proyecto:

```bash
git clone https://github.com/sinergianetworks/flota-admin.git
cd flota-admin
```

---

## 1. Crear el proyecto en Supabase Cloud

1. En el panel de Supabase: **New project**.
   - Elige un nombre y la región más cercana a tus usuarios.
   - Define una **contraseña de base de datos** y guárdala: la necesitarás en el paso 2.
2. Espera a que el proyecto termine de crearse.
3. Anota estos datos (los usarás más adelante):

   | Dato | Dónde está |
   |---|---|
   | **Project ref** | *Project Settings → General* (p. ej. `abcdefghijklmnopqrst`) |
   | **Project URL** | *Project Settings → Data API* (`https://<ref>.supabase.co`) |
   | **Publishable key** | *Project Settings → API Keys* (`sb_publishable_…`) |
   | **Secret key** | *Project Settings → API Keys* (`sb_secret_…`, pulsa *Reveal*) |

   Si en *API Keys* aparece el botón **Create new API keys**, púlsalo para generar las keys publishable y secret.

4. **Cierra el registro público.** En *Authentication → Sign In / Providers*, desactiva **Allow new users to sign up**. Los usuarios los crea el administrador desde la app.

> La **secret key** da acceso total al proyecto: úsala solo en tu computadora (paso 5) y nunca la pongas en el frontend ni en el repositorio.

## 2. Crear la base de datos (`supabase link` + `supabase db push`)

```bash
npx supabase@latest login
npx supabase@latest link --project-ref <tu-project-ref>
npx supabase@latest db push
```

- `login` abre el navegador para autorizar el CLI. Si ya lo usaste antes en esta computadora, puedes omitirlo.
- `link` vincula la carpeta al proyecto. Según la versión del CLI puede pedir la contraseña de la base de datos del paso 1; las versiones recientes se conectan por la API y no la piden.
- `db push` aplica las migraciones de `supabase/migrations/`. Te muestra la lista y te pide confirmar.

> Antes de `db push`, comprueba que el proyecto vinculado es el correcto: `cat supabase/.temp/project-ref` debe mostrar tu project ref. Si en tu cuenta hay otros proyectos, un `link` equivocado aplicaría las migraciones en el proyecto que no es.

La base queda con:

- tablas `profiles`, `vehicles`, `vehicle_log`, `vehicle_daily_mileage`, `gps_cache`, `fleet_settings` y `reminder_log`, con sus políticas RLS, y la vista `vehicle_odometer`;
- buckets privados `vehicle-photos` y `vehicle-docs`;
- las extensiones `pg_cron` y `pg_net`, y los jobs de sincronización. Estos quedan inactivos hasta el paso 8.

Para verificar: en *Table Editor* deben aparecer las 7 tablas y la vista `vehicle_odometer`, y en *Storage* los 2 buckets.

## 3. Desplegar las edge functions

```bash
npx supabase@latest functions deploy --use-api
```

Despliega `create-user`, `gps-status`, `sync-mileage`, `send-reminders` y `send-weekly-report`. `--use-api` empaqueta en los servidores de Supabase, así que no necesitas Docker.

Las cinco funciones se despliegan con **Verify JWT desactivado** (lo define `supabase/config.toml`), porque cada una valida la sesión en su propio código. En *Edge Functions* del panel deben verse las cinco, con *Verify JWT* en **off**.

## 4. Configurar los secrets de las funciones

```bash
cp supabase/functions/.env.example supabase/functions/.env
openssl rand -hex 32          # genera el secreto del cron; cópialo
```

Edita `supabase/functions/.env`:

| Secret | Valor |
|---|---|
| `APP_TIMEZONE` | Zona horaria IANA de la empresa, p. ej. `America/Mexico_City`. Define qué es "un día" de kilometraje. |
| `SYNC_CRON_SECRET` | El valor generado con `openssl` (guárdalo: lo usarás en el paso 8). |
| `TRACKSOLID_*` | Solo si usas Tracksolid (ver paso 7). Si no, déjalos vacíos. |

Súbelos y verifica:

```bash
npx supabase@latest secrets set --env-file supabase/functions/.env
npx supabase@latest secrets list
```

`SUPABASE_URL` y las API keys las inyecta Supabase en las funciones: no las agregues.

> `supabase/functions/.env` está en `.gitignore`. No lo subas a ningún repositorio.

## 5. Crear el primer administrador

**Opción A: script** (recomendada):

```bash
SUPABASE_URL=https://<tu-project-ref>.supabase.co \
SUPABASE_SECRET_KEY=sb_secret_... \
sh scripts/crear-primer-admin.sh
```

Pide correo, nombre y contraseña (mínimo 8 caracteres). Crea el usuario ya confirmado y le asigna el rol de administrador.

**Opción B: desde el panel:**

1. *Authentication → Users → Add user → Create new user*. Escribe el correo y la contraseña, y marca **Auto Confirm User**.
2. En *SQL Editor*, ejecuta el contenido de [`supabase/bootstrap/primer_admin.sql`](../supabase/bootstrap/primer_admin.sql), reemplazando el correo y el nombre.

Los demás usuarios (administradores o conductores) se crean después desde la propia app: **Usuarios → Nuevo usuario**.

## 6. Levantar el frontend (Docker o Easypanel)

Sigue [DESPLIEGUE.md](DESPLIEGUE.md). En resumen, con Docker Compose:

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

En `.env` completa `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` y `APP_TIMEZONE` (la **misma** zona del paso 4). Opcionalmente, también `APP_NAME`, `APP_LOGO_URL` y `APP_PRIMARY_COLOR`.

Después, en Supabase, abre *Authentication → URL Configuration*:

- **Site URL**: `https://<tu-dominio>`
- **Redirect URLs**: agrega `https://<tu-dominio>/nueva-contrasena`

Sin esto, los correos de recuperación de contraseña no llevan a tu dominio.

Entra a `https://<tu-dominio>` con el administrador del paso 5. Ya puedes agregar vehículos: **sin GPS la app funciona igual**, y el kilometraje se toma de las lecturas que se registran en la bitácora.

## 7. Configurar un proveedor GPS (opcional)

### Tracksolid Pro

1. Consigue las credenciales de la API "open" de Tracksolid Pro: **app key**, **app secret**, y el **usuario** y la **contraseña** de la cuenta que tiene los equipos.
2. Calcula el MD5 de la contraseña:

   ```bash
   printf '%s' 'la-contraseña' | md5        # macOS
   printf '%s' 'la-contraseña' | md5sum     # Linux (copia solo el hash)
   ```

3. Completa en `supabase/functions/.env`:

   ```
   TRACKSOLID_APP_KEY=...
   TRACKSOLID_APP_SECRET=...
   TRACKSOLID_USER_ID=...
   TRACKSOLID_USER_PWD_MD5=...
   ```

   Opcionales:
   - `TRACKSOLID_TARGET`: la cuenta cuyos equipos se listan, si no es la misma del usuario.
   - `TRACKSOLID_BASE_URL`: el endpoint regional. Por defecto se usa `https://us-open.tracksolidpro.com/route/rest`; cámbialo si tu cuenta está en otra región.

4. Vuelve a subir los secrets:

   ```bash
   npx supabase@latest secrets set --env-file supabase/functions/.env
   ```

5. En la app, abre **Vehículos → Agregar** (o edita un vehículo) y revisa la sección **Rastreo GPS**:
   - *Tracksolid Pro* debe aparecer sin la marca "(sin configurar)".
   - Al elegirlo, debe cargarse la lista de equipos de la cuenta. Si no carga, se muestra el error del proveedor y puedes escribir el IMEI a mano.
6. Asigna un equipo a cada vehículo y define su **odómetro base**: el kilometraje real al instalar el GPS. Los km diarios se suman a ese valor.

Para agregar otro proveedor, consulta [PROVEEDORES_GPS.md](PROVEEDORES_GPS.md).

## 8. Activar los jobs programados (kilometraje y recordatorios)

Los jobs ya existen desde el paso 2, pero no hacen nada hasta que se guardan la URL del proyecto y el secreto en **Vault**. Esto es necesario tanto para el cron de kilometraje como para los recordatorios por correo del paso 9, aunque no uses GPS. En *SQL Editor* ejecuta, una sola vez:

```sql
select vault.create_secret('https://<tu-project-ref>.supabase.co', 'flota_project_url');
select vault.create_secret('<el mismo SYNC_CRON_SECRET del paso 4>', 'flota_sync_secret');
```

Prueba una sincronización manual y revisa la respuesta:

```sql
select public.flota_request_mileage_sync('today');

-- unos segundos después:
select status_code, content
from net._http_response
order by created desc
limit 1;
```

Debe responder `200`, con algo como `{"date":"…","synced":N,"errors":[]}`.

Verifica los jobs programados:

```sql
select jobname, schedule, active from cron.job where jobname like 'flota-%';
```

| Job | Frecuencia | Qué hace |
|---|---|---|
| `flota-sync-km-hoy` | cada hora (minuto 5) | km del día en curso |
| `flota-sync-km-ayer` | cada 6 horas | cierra el día anterior |
| `flota-recordatorios` | cada hora (minuto 10) | envía la alerta diaria de mantenimiento, si hay algo por vencer |
| `flota-reporte-semanal` | cada hora (minuto 15) | envía el reporte semanal el día configurado |

El cron corre en UTC, pero el día se calcula en `APP_TIMEZONE`. Además, el administrador puede forzar la sincronización del día con el botón ⟳ de la pantalla de vehículos.

## 9. Correos: alertas diarias y reporte semanal (opcional)

Flota Admin envía dos correos a la **lista de destinatarios** de Configuración (si está vacía, a los administradores activos):

- **Alerta diaria de mantenimiento:** a partir de las 7:00 (hora de `APP_TIMEZONE`), solo si hay mantenimientos por km o por fecha por vencer o vencidos. Los avisos por km incluyen los días estimados según el uso de los últimos 28 días (vehículos con GPS). Se repite cada día hasta que se actualice el mantenimiento en la app.
- **Reporte semanal:** el día elegido (lunes por defecto), a partir de las 7:00. Resume todos los vehículos: odómetro, km de la semana, próximo mantenimiento, seguro y alertas.

> Requiere los secretos de Vault del paso 8, aunque no uses GPS. Mientras no completes `RESEND_API_KEY` (más abajo), los jobs no hacen nada: no se envían correos ni se registran errores.

1. Crea una cuenta en [Resend](https://resend.com):
   - *Domains → Add domain*: agrega los registros DNS que indica y espera a que el dominio quede **verificado**.
   - *API Keys → Create*: genera una key con permiso de envío.
2. Completa en `supabase/functions/.env` `RESEND_API_KEY`, `EMAIL_FROM` (con el dominio verificado) y `APP_URL`, y súbelos:

   ```bash
   npx supabase@latest secrets set --env-file supabase/functions/.env
   ```

3. En la app, entra a **Configuración**, carga los destinatarios, elige el día del reporte y usa **Probar alerta diaria** y **Probar reporte semanal**.

Los jobs `flota-recordatorios` y `flota-reporte-semanal` usan los mismos secretos de Vault que el cron de kilometraje (paso 8), así que no hace falta nada más. Para revisar los envíos:

```sql
select kind, local_date, status, item_count, recipients, error
from public.reminder_log
order by local_date desc, kind
limit 20;
```

La columna `kind` indica el correo: `daily` = alerta diaria, `weekly` = reporte semanal.

| status | Significado |
|---|---|
| `sent` | Correo enviado. |
| `nothing_to_send` | No había vencimientos ese día; no se envió correo. |
| `disabled` | Registros anteriores; ya no se registra (si el correo está desactivado, no se reserva el día). |
| `error` | No se pudo enviar (ver columna `error`); se reintenta cada hora ese día. |
| `sending` | Envío en curso, o posiblemente enviado si quedó así (corte de red o error al registrar); no se reintenta para no duplicar. |

---

## Lista de verificación

- [ ] Registro público desactivado (paso 1).
- [ ] `db push` sin errores; 7 tablas, la vista `vehicle_odometer` y 2 buckets (paso 2).
- [ ] 5 funciones desplegadas con *Verify JWT* en off (paso 3).
- [ ] `secrets list` muestra `APP_TIMEZONE` y `SYNC_CRON_SECRET` (paso 4).
- [ ] El administrador inicia sesión y ve **Vehículos** y **Usuarios** (pasos 5 y 6).
- [ ] *Site URL* y *Redirect URLs* configuradas (paso 6).
- [ ] Un conductor de prueba ve solo el vehículo que tiene asignado.
- [ ] (GPS) El proveedor aparece configurado y el mapa muestra la posición (paso 7).
- [ ] `flota_request_mileage_sync('today')` responde 200 (paso 8).
- [ ] (Correo) La alerta diaria y el reporte semanal de prueba llegan desde **Configuración** (paso 9).

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| La app muestra **"Configuración incompleta"** | Falta una variable en el contenedor. Revisa `.env` y reinicia. |
| **"Credenciales incorrectas"** con un usuario recién creado | El usuario no está confirmado. En *Authentication → Users*, confírmalo o créalo con *Auto Confirm*. |
| El admin entra pero **no ve "Usuarios"** | El perfil no tiene rol admin. Ejecuta `supabase/bootstrap/primer_admin.sql`. |
| Error **401/403** al crear usuarios o ver el GPS | Funciones sin desplegar o con *Verify JWT* activado. Repite el paso 3. |
| **"Falta el secret APP_TIMEZONE"** | Repite el paso 4. |
| `sync-mileage` responde **401** desde el cron | `flota_sync_secret` en Vault no es igual a `SYNC_CRON_SECRET`, o tiene menos de 16 caracteres. |
| El proveedor aparece **"(sin configurar)"** | Falta alguno de los secrets `TRACKSOLID_*`. |
| El enlace de recuperación de contraseña lleva a otro sitio | *Site URL* y *Redirect URLs* (paso 6). |
| Los recordatorios no llegan y `reminder_log` no tiene filas | Sin `RESEND_API_KEY` el job no hace nada (no es un error): completa el paso 9. También revisa que los recordatorios o el reporte semanal no estén desactivados en Configuración, y para el semanal, que hoy sea el día configurado. |
| **"Faltan secrets para enviar correos"** al pulsar *Enviar correo de prueba* | Falta `RESEND_API_KEY`, `EMAIL_FROM` o `APP_URL` (paso 9). |
| **"Resend (403)"** al enviar la prueba | El dominio de `EMAIL_FROM` no está verificado en Resend. |
| `reminder_log` en `error` con `APP_URL debe empezar con http:// o https://` | Corrige el secret `APP_URL`. |

Para ver errores de las funciones: *Edge Functions → (función) → Logs*. Para ver las llamadas del cron: `select * from net._http_response order by created desc;`.
