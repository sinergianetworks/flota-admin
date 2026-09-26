# ─────────────────────────────────────────────────────────────
# Flota Admin · imagen del frontend
#
# La imagen NO lleva configuración: la URL de Supabase, la publishable key,
# el nombre de la empresa, etc. se leen de variables de entorno al arrancar
# el contenedor (docker/40-env-config.sh genera /env-config.js). Así la misma
# imagen sirve para cualquier instalación.
# ─────────────────────────────────────────────────────────────

# ── 1. Build ─────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY index.html vite.config.ts tsconfig*.json tailwind.config.js postcss.config.js components.json ./
COPY public ./public
COPY src ./src

# Acota el heap de Node para builders con poca RAM libre.
ENV NODE_OPTIONS=--max-old-space-size=768
RUN npm run build

# ── 2. Servidor estático ─────────────────────────────────────
FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
# La imagen oficial de Nginx ejecuta /docker-entrypoint.d/*.sh al arrancar.
COPY --chmod=755 docker/40-env-config.sh /docker-entrypoint.d/40-env-config.sh
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
