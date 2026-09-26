# Proveedores GPS

Flota Admin no depende de un proveedor GPS concreto. Cada proveedor es un módulo de las edge functions que implementa la interfaz `GpsProvider`. Agregar uno nuevo consiste en **crear un archivo y registrarlo**: no hay que tocar la base de datos, el frontend ni las otras funciones.

## Cómo encaja

```
Frontend ──► gps-status ──┐
                          ├──► providers/index.ts ──► tracksolid.ts
pg_cron ───► sync-mileage ┘                       └──► tu-proveedor.ts
```

- Cada vehículo guarda `gps_provider` (el `id` del proveedor) y `gps_device_id` (el identificador del equipo en ese proveedor, p. ej. el IMEI).
- **`gps-status`** atiende al frontend:
  - lista los proveedores;
  - lista los equipos de una cuenta (solo admin);
  - devuelve la posición en vivo de los vehículos que el usuario puede ver, respetando la RLS.
- **`sync-mileage`** agrupa los vehículos por proveedor, pide los km del día y los guarda en `vehicle_daily_mileage`.
- El frontend **nunca** habla directamente con el proveedor, y las credenciales **nunca** salen de las edge functions.

Los archivos están en `supabase/functions/_shared/gps/`:

| Archivo | Contenido |
|---|---|
| `types.ts` | Interfaz `GpsProvider` y tipos `GpsDevice` y `DeviceStatus` |
| `providers/index.ts` | Registro de proveedores |
| `providers/tracksolid.ts` | Implementación de referencia |
| `cache.ts` | Caché compartida en la tabla `gps_cache` (tokens, respuestas costosas) |

## La interfaz

```ts
export interface GpsProvider {
  id: string                 // valor guardado en vehicles.gps_provider (no lo cambies después)
  name: string               // nombre visible en la app

  isConfigured(): boolean                                   // ¿están los secrets?
  validateCredentials(): Promise<void>                      // lanza si no funcionan

  getDailyMileage(deviceIds: string[], from: Date, to: Date): Promise<Record<string, number>>

  getCurrentOdometer?(deviceIds: string[]): Promise<Record<string, number>>
  listDevices?(): Promise<GpsDevice[]>
  getLiveStatus?(deviceIds: string[]): Promise<DeviceStatus[]>
}
```

| Método | Obligatorio | Lo usa | Qué debe hacer |
|---|---|---|---|
| `isConfigured` | Sí | `gps-status`, `sync-mileage` | `true` si están todas las variables de entorno necesarias. No hace llamadas de red. |
| `validateCredentials` | Sí | `gps-status` (`validate`) | Autenticarse contra el proveedor. Lanza un `Error` con un mensaje claro si falla. |
| `getDailyMileage` | Sí | `sync-mileage` | Km recorridos por cada equipo entre `from` y `to`. Devuelve `{ deviceId: km }`. |
| `getCurrentOdometer` | No | (reservado) | Odómetro total que informa el equipo, en km. |
| `listDevices` | No | Selector de equipos en la app | Equipos de la cuenta. Sin este método, el admin escribe el ID a mano. |
| `getLiveStatus` | No | Tarjetas y mapa | Posición y estado actual. Sin este método, el vehículo no aparece en el mapa, pero el kilometraje funciona. |

Detalles de `getDailyMileage`:

- `from` y `to` son instantes UTC que delimitan **un día en `APP_TIMEZONE`**. La conversión ya está hecha, incluido el horario de verano: el proveedor solo tiene que pedir el rango tal cual (formatéalo en UTC si su API lo espera así).
- Recibe **todos** los equipos del proveedor de una vez. Si la API tiene un límite por llamada, parte la lista en lotes; Tracksolid, por ejemplo, usa lotes de 50.
- Los equipos que el proveedor no devuelva se guardan con **0 km** ese día. Si la llamada falla, **lanza**: `sync-mileage` registra el error y no sobrescribe los datos de ese proveedor.
- Debe ser **idempotente**: se llama cada hora para el día en curso, y el resultado reemplaza al anterior.

Campos de `DeviceStatus`:

```ts
{
  deviceId: string        // mismo id que gps_device_id
  online: boolean         // el equipo reporta
  engineOn: boolean       // contacto / ACC encendido
  speedKmh: number
  lat: number | null      // null si no hay posición
  lng: number | null
  positionTime: string | null  // tal como lo da el proveedor (solo se muestra)
  lastSeen: string | null
  positionFresh: boolean  // false si la posición es vieja: la app no muestra la velocidad
}
```

## Paso a paso: agregar un proveedor

Como ejemplo, un proveedor ficticio "Acme GPS".

### 1. Crear el archivo

`supabase/functions/_shared/gps/providers/acme.ts`:

```ts
import { gpsCache } from '../cache.ts'
import type { DeviceStatus, GpsDevice, GpsProvider } from '../types.ts'

const ID = 'acme'

function env(name: string) {
  return (Deno.env.get(name) ?? '').trim()
}

async function getToken(): Promise<string> {
  const cache = gpsCache(ID)
  const cached = await cache.get('token')
  if (cached) return cached

  const res = await fetch('https://api.acme-gps.example/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env('ACME_CLIENT_ID'), client_secret: env('ACME_CLIENT_SECRET') }),
  })
  if (!res.ok) throw new Error(`Acme: autenticación fallida (HTTP ${res.status})`)
  const { access_token, expires_in } = await res.json()
  await cache.set('token', access_token, Math.max(60, expires_in - 300))
  return access_token
}

async function api(path: string) {
  const res = await fetch(`https://api.acme-gps.example${path}`, {
    headers: { Authorization: `Bearer ${await getToken()}` },
  })
  if (!res.ok) throw new Error(`Acme: ${path} → HTTP ${res.status}`)
  return res.json()
}

export const acme: GpsProvider = {
  id: ID,
  name: 'Acme GPS',

  isConfigured: () => !!(env('ACME_CLIENT_ID') && env('ACME_CLIENT_SECRET')),

  async validateCredentials() {
    await gpsCache(ID).delete('token')
    await getToken()
  },

  async getDailyMileage(deviceIds, from, to) {
    const km: Record<string, number> = {}
    for (const id of deviceIds) {
      const r = await api(`/devices/${id}/distance?from=${from.toISOString()}&to=${to.toISOString()}`)
      km[id] = r.meters / 1000
    }
    return km
  },

  async listDevices(): Promise<GpsDevice[]> {
    const list = await api('/devices')
    return list.map((d: { id: string; label: string; plate?: string }) => ({
      id: d.id, name: d.label, plate: d.plate ?? null,
    }))
  },

  async getLiveStatus(deviceIds): Promise<DeviceStatus[]> {
    const list = await api(`/positions?ids=${deviceIds.join(',')}`)
    return list.map((p: any) => ({
      deviceId: p.device_id,
      online: p.online,
      engineOn: p.ignition,
      speedKmh: p.speed,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      positionTime: p.fix_time ?? null,
      lastSeen: p.last_seen ?? null,
      positionFresh: p.fix_age_seconds < 300,
    }))
  },
}
```

### 2. Registrarlo

`supabase/functions/_shared/gps/providers/index.ts`:

```ts
import { tracksolid } from './tracksolid.ts'
import { acme } from './acme.ts'

const PROVIDERS: GpsProvider[] = [
  tracksolid,
  acme,
]
```

### 3. Documentar y configurar sus secrets

Agrega las variables a `supabase/functions/.env.example` con un comentario, y súbelas en cada instalación que lo use:

```bash
npx supabase@latest secrets set ACME_CLIENT_ID=... ACME_CLIENT_SECRET=...
```

### 4. Probar y desplegar

```bash
cd supabase/functions
npx -y deno check gps-status/index.ts sync-mileage/index.ts
npx -y deno test --allow-net --allow-env _tests/
cd ../..
npx supabase@latest functions deploy gps-status sync-mileage --use-api
```

Hay que redesplegar `gps-status` y `sync-mileage`: cada función se empaqueta con el código compartido.

Para escribir tests, sigue el modelo de `_tests/tracksolid_test.ts`: levanta un servidor HTTP falso que responde como la API del proveedor y como PostgREST para `gps_cache`.

### 5. Usarlo

En la app, edita un vehículo:

1. En **Rastreo GPS**, elige *Acme GPS*.
2. Selecciona el equipo, o escribe su ID a mano.
3. Guarda. Desde la siguiente hora, el cron empieza a registrar sus km.

## Buenas prácticas

- **Credenciales solo en secrets** (`Deno.env`). Nunca en el código, en tablas ni en el frontend.
- **Cachea los tokens** en `gps_cache` (`gpsCache(ID)`): varias instancias de las funciones comparten la caché y así se evita chocar con los límites de la API.
- **Mensajes de error claros**, que se muestran al admin: `"Acme: autenticación fallida (HTTP 401)"` mejor que `"error"`.
- **No cambies el `id`** de un proveedor que ya está en uso: los vehículos lo tienen guardado en `gps_provider`.
- Si el proveedor informa horas locales en lugar de UTC, conviértelas antes de comparar. `positionTime` y `lastSeen` solo se muestran, pero `positionFresh` debe calcularse bien.
