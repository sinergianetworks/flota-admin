# Actualización de una instalación

Una actualización puede traer cambios en tres partes. Aplícalas **en este orden**: primero la base de datos, luego las funciones y por último el frontend. El frontend nuevo puede depender de columnas o funciones nuevas; al revés, casi nunca hay problema.

| Parte | Dónde vive | Cómo se actualiza |
|---|---|---|
| Base de datos | `supabase/migrations/` | `supabase db push` |
| Edge functions | `supabase/functions/` | `supabase functions deploy` |
| Frontend | Imagen Docker | Rebuild o nueva imagen |

Revisa siempre las notas de la versión (el mensaje del tag o del release) por si hay **secrets o variables nuevas** que definir.

## 0. Antes de empezar

- **Respaldo:** en *Database → Backups* confirma que hay un backup reciente. En el plan gratuito no hay backups automáticos: exporta los datos con `npx supabase@latest db dump --data-only -f respaldo.sql` antes de migrar.
- Elige un momento de poco uso. La actualización no corta el servicio, pero durante unos minutos puede convivir el frontend viejo con la base nueva.

## 1. Obtener la versión nueva

```bash
cd flota-admin
git fetch --tags
git checkout v1.2.0        # la versión a instalar (o: git pull en main)
```

## 2. Base de datos

```bash
npx supabase@latest link --project-ref <tu-project-ref>   # solo si esta carpeta no está vinculada
npx supabase@latest migration list                         # compara las migraciones locales y remotas
npx supabase@latest db push                                # aplica solo las pendientes
```

`db push` aplica únicamente las migraciones que faltan en el proyecto y pide confirmación.

> Nunca edites una migración que ya se aplicó en alguna instalación: cualquier cambio va en una migración **nueva**. Tampoco uses `supabase db reset` contra un proyecto con datos: **borra todo**.

## 3. Edge functions

```bash
npx supabase@latest functions deploy --use-api
```

Si la versión trae secrets nuevos, agrégalos a `supabase/functions/.env` y súbelos:

```bash
npx supabase@latest secrets set --env-file supabase/functions/.env
```

## 4. Frontend

**Docker Compose con build local:**

```bash
docker compose up -d --build
```

**Docker Compose con imagen publicada:** cambia la etiqueta en `docker-compose.yml` (p. ej. `ghcr.io/sinergianetworks/flota-admin:1.2.0`) y luego:

```bash
docker compose pull
docker compose up -d
```

**Easypanel desde el repositorio:** si apunta a una rama, basta con **Deploy**. Si quieres fijar una versión, apunta el servicio al tag.

**Easypanel desde imagen:** cambia la etiqueta de la imagen en el servicio y pulsa **Deploy**.

Si la versión trae variables de entorno nuevas, agrégalas antes de reiniciar el contenedor. Cambiar solo variables no requiere rebuild: basta con reiniciar.

## 5. Verificar

- `https://<tu-dominio>/healthz` responde `ok`.
- Recarga la app forzando la caché (Ctrl/Cmd + Shift + R) e inicia sesión.
- Si hay GPS, pulsa ⟳ en **Vehículos** y verifica que la posición y los km se actualizan.
- En *Edge Functions → Logs* no deben aparecer errores nuevos.

## Revertir

- **Frontend:** vuelve a la etiqueta o commit anterior y redespliega.
- **Funciones:** `git checkout <versión-anterior>` y `functions deploy`.
- **Base de datos:** las migraciones no se deshacen solas. Si una migración causa problemas, la corrección es una migración nueva. En caso grave, restaura el backup del paso 0.

## Para quien mantiene el proyecto: publicar una versión

1. Los cambios de esquema van en una migración nueva: `supabase/migrations/AAAAMMDDHHMMSS_descripcion.sql`.
2. Verifica:

   ```bash
   npm run lint
   npm run build
   ```

   Y los tests de funciones:

   ```bash
   cd supabase/functions
   npx -y deno test --allow-net --allow-env _tests/
   ```

3. Anota en el mensaje del tag los secrets y variables nuevos, y cualquier paso manual.
4. Crea el tag:

   ```bash
   git tag -a v1.2.0 -m "..."
   git push origin v1.2.0
   ```

   El workflow publica la imagen en GHCR.
