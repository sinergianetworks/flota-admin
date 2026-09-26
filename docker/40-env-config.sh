#!/bin/sh
# Genera /env-config.js a partir de las variables de entorno del contenedor.
#
# La imagen oficial de Nginx ejecuta los scripts de /docker-entrypoint.d/ antes
# de arrancar, así que una misma imagen sirve para cualquier instalación: basta
# con cambiar las variables y reiniciar el contenedor.
set -eu

TARGET="${ENV_CONFIG_PATH:-/usr/share/nginx/html/env-config.js}"

# Variables expuestas al navegador. Solo valores públicos: la publishable key
# (o la anon key legacy) está pensada para el cliente. NUNCA agregues la secret
# key ni la service_role key.
VARS="SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_ANON_KEY APP_NAME APP_LOGO_URL APP_PRIMARY_COLOR APP_TIMEZONE APP_CURRENCY"

# Escapa un valor para usarlo dentro de una cadena JSON entre comillas dobles.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/</\\u003c/g' | tr -d '\n\r'
}

{
  printf 'window.__ENV__ = {\n'
  for name in $VARS; do
    eval "value=\${$name:-}"
    if [ -n "$value" ]; then
      printf '  "%s": "%s",\n' "$name" "$(json_escape "$value")"
    fi
  done
  printf '};\n'
} > "$TARGET"

echo "env-config: $TARGET generado"
