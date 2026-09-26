#!/bin/sh
# Crea el primer administrador de una instalación nueva de Flota Admin.
#
# Uso:
#   SUPABASE_URL=https://<ref>.supabase.co \
#   SUPABASE_SECRET_KEY=sb_secret_... \
#   sh scripts/crear-primer-admin.sh
#
# Pide correo, nombre y contraseña; crea el usuario en Auth (ya confirmado)
# y le asigna el rol admin. La secret key (o la service_role legacy) se usa
# solo en esta máquina: no la guardes en el repositorio ni en el frontend.
set -eu

: "${SUPABASE_URL:?Define SUPABASE_URL (https://<ref>.supabase.co)}"
: "${SUPABASE_SECRET_KEY:?Define SUPABASE_SECRET_KEY (Settings → API Keys → secret)}"
command -v curl >/dev/null || { echo "Se necesita curl." >&2; exit 1; }

URL="${SUPABASE_URL%/}"

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}


request() {
  # request METHOD PATH BODY [EXTRA_HEADER]
  method=$1; path=$2; body=$3; extra=${4:-}
  set -- -sS -w '\n%{http_code}' -X "$method" "$URL$path" -H "Content-Type: application/json"
  # Las keys nuevas (sb_secret_...) van solo en el header apikey; la
  # service_role legacy (un JWT) además en Authorization.
  case "$SUPABASE_SECRET_KEY" in
    eyJ*) set -- "$@" -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" ;;
    *)    set -- "$@" -H "apikey: $SUPABASE_SECRET_KEY" ;;
  esac
  [ -n "$extra" ] && set -- "$@" -H "$extra"
  curl "$@" --data "$body"
}

printf 'Correo del administrador: '; read -r EMAIL
printf 'Nombre completo: '; read -r FULL_NAME
stty -echo 2>/dev/null || true
printf 'Contraseña (mín. 8 caracteres): '; read -r PASSWORD; echo
stty echo 2>/dev/null || true

EMAIL=$(printf '%s' "$EMAIL" | tr 'A-Z' 'a-z' | tr -d ' ')
[ ${#PASSWORD} -ge 8 ] || { echo "La contraseña debe tener al menos 8 caracteres." >&2; exit 1; }

echo "Creando usuario en Auth..."
RES=$(request POST /auth/v1/admin/users \
  "{\"email\":\"$(json_escape "$EMAIL")\",\"password\":\"$(json_escape "$PASSWORD")\",\"email_confirm\":true,\"user_metadata\":{\"full_name\":\"$(json_escape "$FULL_NAME")\"}}")
CODE=$(printf '%s' "$RES" | tail -n1)
BODY=$(printf '%s' "$RES" | sed '$d')
if [ "$CODE" -lt 200 ] || [ "$CODE" -ge 300 ]; then
  echo "Error al crear el usuario (HTTP $CODE): $BODY" >&2
  echo "Si el usuario ya existe, usa supabase/bootstrap/primer_admin.sql para asignarle el rol." >&2
  exit 1
fi

echo "Asignando rol de administrador..."
RES=$(request PATCH "/rest/v1/profiles?email=eq.$(printf '%s' "$EMAIL" | sed 's/+/%2B/g; s/@/%40/g')" \
  "{\"role\":\"admin\",\"full_name\":\"$(json_escape "$FULL_NAME")\"}" "Prefer: return=representation")
CODE=$(printf '%s' "$RES" | tail -n1)
BODY=$(printf '%s' "$RES" | sed '$d')
if [ "$CODE" -lt 200 ] || [ "$CODE" -ge 300 ] || [ "$BODY" = "[]" ]; then
  echo "El usuario se creó pero no se pudo asignar el rol (HTTP $CODE): $BODY" >&2
  echo "¿Aplicaste las migraciones (supabase db push)? Luego usa supabase/bootstrap/primer_admin.sql." >&2
  exit 1
fi

echo "Listo: $EMAIL es administrador. Ya puedes iniciar sesión en Flota Admin."
