# Despliegue del frontend

Flota Admin tiene dos partes:

- **Backend en Supabase Cloud**: base de datos, autenticación, archivos y edge functions. Se configura siguiendo [INSTALACION.md](INSTALACION.md).
- **Frontend web**: una imagen Docker con Nginx que sirve la aplicación. Esta guía cubre solo esta parte.

La imagen **no lleva configuración adentro**. La URL de Supabase, la publishable key, el nombre de la empresa, etc. se leen de variables de entorno **al arrancar el contenedor**. Una misma imagen sirve para cualquier instalación: para cambiar un valor basta con editar la variable y reiniciar el contenedor, sin reconstruir.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `SUPABASE_URL` | Sí | URL del proyecto: `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Sí* | Publishable key (`sb_publishable_…`) |
| `SUPABASE_ANON_KEY` | Sí* | Solo si el proyecto usa las keys legacy. *Basta con una de las dos. |
| `APP_TIMEZONE` | Sí | Zona horaria IANA, p. ej. `America/Mexico_City`. Igual que el secret de las edge functions. |
| `APP_NAME` | No | Nombre de la empresa. Por defecto: `Flota Admin` |
| `APP_LOGO_URL` | No | URL del logo. Por defecto: logo neutro incluido |
| `APP_PRIMARY_COLOR` | No | Color primario en hex, p. ej. `#0f766e` |
| `APP_CURRENCY` | No | Símbolo de moneda. Por defecto: `$` |

Todas llegan al navegador: **nunca** pongas ahí la secret key ni la service_role key. Si falta una variable obligatoria, la app muestra una pantalla que indica cuál.

El archivo [`.env.example`](../.env.example) trae todas las variables comentadas.

---

## Opción A · Docker Compose

Requisitos: un servidor con Docker y Docker Compose.

```bash
git clone https://github.com/sinergianetworks/flota-admin.git
cd flota-admin
cp .env.example .env
nano .env                      # completa SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY y APP_TIMEZONE
docker compose up -d --build
```

La app queda en `http://<servidor>:8080`. Para cambiar el puerto, define `FLOTA_PORT` en `.env`.

Para producción, pon delante un proxy con HTTPS (Caddy, Traefik, Nginx Proxy Manager…) que apunte al puerto publicado.

Comandos útiles:

```bash
docker compose logs -f          # logs (al arrancar debe verse "env-config: ... generado")
docker compose restart          # aplica cambios en .env
docker compose ps               # estado; la columna STATUS muestra (healthy)
```

## Opción B · Docker sin Compose

```bash
docker build -t flota-admin .
docker run -d --name flota-admin --restart unless-stopped -p 8080:80 --env-file .env flota-admin
```

---

## Opción C · Easypanel desde el repositorio

1. En Easypanel, crea un proyecto y dentro un servicio **App**.
2. **Source → GitHub**: elige el repositorio `flota-admin` y la rama `main`.
   - El repositorio es privado, así que Easypanel necesita acceso. Configura un token en *Settings → GitHub* con permiso de lectura sobre el repo.
3. **Build → Dockerfile**: deja la ruta `Dockerfile`.
4. **Environment**: pega las variables (el mismo formato que `.env`).
5. **Domains**: agrega el dominio y usa el **puerto 80** del contenedor. Easypanel gestiona el certificado HTTPS.
6. **Deploy**.

Si modificas variables de entorno, basta con **Restart**, sin volver a construir. Para instalar una versión nueva del código, haz un **Deploy** del servicio.

> Si el build falla con `Killed` a mitad de camino, el servidor se quedó sin RAM. El Dockerfile limita el heap de Node a 768 MB. Libera memoria o agrega swap al servidor.

## Opción D · Easypanel (o cualquier host) desde una imagen

El workflow `.github/workflows/docker.yml` publica la imagen en GitHub Container Registry al crear un tag `v*`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Genera `ghcr.io/sinergianetworks/flota-admin:1.0.0`, `:1.0` y `:latest`.

En Easypanel:

1. Servicio **App** → **Source → Docker Image** → `ghcr.io/sinergianetworks/flota-admin:1.0.0`.
2. El paquete es privado: agrega las credenciales del registro (`ghcr.io`, usuario de GitHub y un *personal access token* con permiso `read:packages`).
3. **Environment**, **Domains** (puerto 80) y **Deploy**, igual que en la opción C.

Con Docker Compose, reemplaza `build: .` por `image: ghcr.io/sinergianetworks/flota-admin:1.0.0` en `docker-compose.yml` y ejecuta `docker login ghcr.io` antes de `docker compose up -d`.

> Fija una versión concreta (`:1.0.0`) en lugar de `:latest` para que las actualizaciones sean deliberadas. Ver [ACTUALIZACION.md](ACTUALIZACION.md).

---

## Verificación

- `https://<tu-dominio>/healthz` responde `ok`.
- `https://<tu-dominio>/env-config.js` muestra tus variables (solo las públicas).
- La pantalla de inicio de sesión muestra el nombre y el color configurados.
- **Supabase → Authentication → URL Configuration**:
  - *Site URL* debe ser `https://<tu-dominio>`.
  - Agrega `https://<tu-dominio>/nueva-contrasena` en *Redirect URLs*.

  Sin esto, el enlace de "¿Olvidaste tu contraseña?" no funciona.

## Qué hace la imagen

- **Etapa de build:** `node:22-alpine` ejecuta `npm ci` y `npm run build`.
- **Etapa final:** `nginx:1.27-alpine` con:
  - fallback SPA (cualquier ruta devuelve `index.html`);
  - caché larga para `/assets/*` (archivos con hash) y sin caché para `index.html` y `env-config.js`;
  - cabeceras de seguridad básicas y el endpoint `/healthz` para el healthcheck.
- **Al arrancar:** `docker/40-env-config.sh` se ejecuta desde `/docker-entrypoint.d/` y genera `/env-config.js`.
