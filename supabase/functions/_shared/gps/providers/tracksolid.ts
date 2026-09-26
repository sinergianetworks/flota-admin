// Proveedor Tracksolid Pro (Jimi IoT) — API "open" /route/rest.
//
// Secrets (supabase secrets set ...):
//   TRACKSOLID_APP_KEY       app key de la cuenta de desarrollador
//   TRACKSOLID_APP_SECRET    app secret
//   TRACKSOLID_USER_ID       usuario (login) de la cuenta Tracksolid
//   TRACKSOLID_USER_PWD_MD5  MD5 de la contraseña de ese usuario (32 hex)
//   TRACKSOLID_TARGET        opcional: cuenta cuyos equipos se listan (por defecto TRACKSOLID_USER_ID)
//   TRACKSOLID_BASE_URL      opcional: endpoint regional (por defecto el de América)
import { crypto } from 'jsr:@std/crypto@1'
import { encodeHex } from 'jsr:@std/encoding@1/hex'
import { gpsCache } from '../cache.ts'
import type { DeviceStatus, GpsDevice, GpsProvider } from '../types.ts'

const ID = 'tracksolid'
const DEFAULT_BASE_URL = 'https://us-open.tracksolidpro.com/route/rest'
const TOKEN_TTL_S = 6800        // el token dura 7200 s; se renueva antes
const DEVICE_LIST_TTL_S = 300
const MILEAGE_BATCH = 50        // equipos por llamada a track.mileage
// Posición "fresca" si su hora está dentro de 5 min del último latido.
const FRESH_WINDOW_MS = 5 * 60 * 1000

function env(name: string): string {
  return (Deno.env.get(name) ?? '').trim()
}

function settings() {
  const userId = env('TRACKSOLID_USER_ID')
  return {
    appKey: env('TRACKSOLID_APP_KEY'),
    appSecret: env('TRACKSOLID_APP_SECRET'),
    userId,
    pwdMd5: env('TRACKSOLID_USER_PWD_MD5'),
    target: env('TRACKSOLID_TARGET') || userId,
    baseUrl: env('TRACKSOLID_BASE_URL') || DEFAULT_BASE_URL,
  }
}

async function md5Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(text))
  return encodeHex(new Uint8Array(digest))
}

// Firma: MD5( secret + k1v1k2v2... (claves ordenadas) + secret ), en mayúsculas.
export async function signParams(params: Record<string, string>, appSecret: string): Promise<string> {
  const raw = appSecret + Object.keys(params).sort().map(k => k + params[k]).join('') + appSecret
  return (await md5Hex(raw)).toUpperCase()
}

// "yyyy-MM-dd HH:mm:ss" en UTC, formato que exige la API.
export function utcTimestamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

interface ApiResponse {
  code: number
  message?: string
  result?: unknown
  data?: unknown
}

class TracksolidError extends Error {
  constructor(public code: number, message: string) {
    super(`Tracksolid (${code}): ${message}`)
  }
}

async function post(params: Record<string, string>): Promise<ApiResponse> {
  const s = settings()
  const signed = { ...params, sign: await signParams(params, s.appSecret) }
  const res = await fetch(s.baseUrl, { method: 'POST', body: new URLSearchParams(signed) })
  if (!res.ok) throw new TracksolidError(res.status, `HTTP ${res.status}`)
  return await res.json() as ApiResponse
}

const cache = () => gpsCache(ID)

async function fetchToken(): Promise<string> {
  const s = settings()
  const json = await post({
    app_key: s.appKey,
    expires_in: '7200',
    format: 'json',
    method: 'jimi.oauth.token.get',
    sign_method: 'md5',
    timestamp: utcTimestamp(),
    user_id: s.userId,
    user_pwd_md5: s.pwdMd5,
    v: '1.0',
  })
  const token = (json.result as { accessToken?: string } | undefined)?.accessToken
  if (json.code !== 0 || !token) throw new TracksolidError(json.code, json.message ?? 'no se obtuvo token')
  return token
}

async function getToken(forceNew = false): Promise<{ token: string; fromCache: boolean }> {
  if (!forceNew) {
    const cached = await cache().get('token')
    if (cached) return { token: cached, fromCache: true }
  }
  const token = await fetchToken()
  await cache().set('token', token, TOKEN_TTL_S)
  return { token, fromCache: false }
}

// Llama a un método autenticado. Si falla usando un token de la caché, pide
// uno nuevo y reintenta una sola vez (el token pudo invalidarse antes de su TTL).
async function call(method: string, extra: Record<string, string> = {}): Promise<ApiResponse> {
  const s = settings()
  const attempt = async (token: string) => post({
    access_token: token,
    app_key: s.appKey,
    format: 'json',
    method,
    sign_method: 'md5',
    timestamp: utcTimestamp(),
    v: '1.0',
    ...extra,
  })

  const first = await getToken()
  let json = await attempt(first.token)
  if (json.code !== 0 && first.fromCache) {
    json = await attempt((await getToken(true)).token)
  }
  if (json.code !== 0) throw new TracksolidError(json.code, json.message ?? 'error desconocido')
  return json
}

// La API devuelve listas con formas distintas según el método.
function asList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const k of ['list', 'deviceList', 'data']) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[]
    }
    if (typeof o.imei === 'string') return [o]
    return Object.values(o).filter(v => v && typeof v === 'object' && 'imei' in (v as object)) as Record<string, unknown>[]
  }
  return []
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

function num(v: unknown): number {
  const n = parseFloat(str(v))
  return isNaN(n) ? 0 : n
}

// "yyyy-MM-dd HH:mm:ss" → ms (se trata como UTC; solo se usa para diferencias).
function parseApiTime(s: string): number {
  if (!s) return NaN
  return Date.parse(s.replace(' ', 'T') + 'Z')
}

export function parseStatus(d: Record<string, unknown>): DeviceStatus {
  const positionTime = str(d.gpsTime)
  const lastSeen = str(d.hbTime ?? d.lastTime ?? d.gpsTime)
  const gpsMs = parseApiTime(positionTime)
  const hbMs = parseApiTime(lastSeen)
  const positionFresh = isNaN(gpsMs) || isNaN(hbMs) ? true : (hbMs - gpsMs) <= FRESH_WINDOW_MS

  const lat = d.lat ?? d.latitude
  const lng = d.lng ?? d.longitude
  return {
    deviceId: str(d.imei),
    // status: "1" online / "0" offline · accStatus: "1" motor encendido
    online: str(d.status) === '1',
    engineOn: str(d.accStatus) === '1',
    speedKmh: num(d.speed),
    lat: lat == null || lat === '' ? null : num(lat),
    lng: lng == null || lng === '' ? null : num(lng),
    positionTime: positionTime || null,
    lastSeen: lastSeen || null,
    positionFresh,
  }
}

// track.mileage devuelve `data` (totales por equipo, en metros) y/o `result`
// (tramos individuales con `distance` en metros). Se prefieren los totales.
export function parseMileage(json: ApiResponse): Record<string, number> {
  const km: Record<string, number> = {}
  if (Array.isArray(json.data)) {
    for (const s of json.data as Record<string, unknown>[]) {
      if (s.imei) km[str(s.imei)] = num(s.totalMileage) / 1000
    }
  }
  if (Array.isArray(json.result)) {
    const withTotals = new Set(Object.keys(km))
    for (const trip of json.result as Record<string, unknown>[]) {
      const imei = str(trip.imei)
      if (!imei || withTotals.has(imei)) continue
      km[imei] = (km[imei] ?? 0) + num(trip.distance) / 1000
    }
  }
  return km
}

async function liveStatus(deviceIds: string[]): Promise<DeviceStatus[]> {
  if (deviceIds.length === 0) return []
  const wanted = new Set(deviceIds)

  // Posición de todos los equipos de la cuenta en una sola llamada.
  try {
    const json = await call('jimi.user.device.location.list', { target: settings().target })
    const list = asList(json.result).filter(d => wanted.has(str(d.imei)))
    if (list.length > 0) return list.map(parseStatus)
  } catch (e) {
    console.warn('tracksolid: location.list falló, se usa location.get', e instanceof Error ? e.message : e)
  }

  // Alternativa: consulta por IMEIs separados por coma.
  const json = await call('jimi.device.location.get', { imeis: deviceIds.join(',') })
  return asList(json.result).filter(d => d.imei).map(parseStatus)
}

export const tracksolid: GpsProvider = {
  id: ID,
  name: 'Tracksolid Pro',

  isConfigured() {
    const s = settings()
    return !!(s.appKey && s.appSecret && s.userId && s.pwdMd5)
  },

  async validateCredentials() {
    await getToken(true)
  },

  async getDailyMileage(deviceIds, from, to) {
    const km: Record<string, number> = {}
    for (let i = 0; i < deviceIds.length; i += MILEAGE_BATCH) {
      const batch = deviceIds.slice(i, i + MILEAGE_BATCH)
      const json = await call('jimi.device.track.mileage', {
        imeis: batch.join(','),
        begin_time: utcTimestamp(from),
        end_time: utcTimestamp(to),
      })
      Object.assign(km, parseMileage(json))
    }
    return km
  },

  async getCurrentOdometer(deviceIds) {
    const json = await call('jimi.device.location.get', { imeis: deviceIds.join(',') })
    const km: Record<string, number> = {}
    for (const d of asList(json.result)) {
      if (d.imei) km[str(d.imei)] = num(d.currentMileage ?? d.totalMileage ?? d.mileage)
    }
    return km
  },

  async listDevices(): Promise<GpsDevice[]> {
    const cached = await cache().get('device_list')
    if (cached) return JSON.parse(cached)

    const json = await call('jimi.user.device.list', { target: settings().target })
    const devices = asList(json.result)
      .filter(d => d.imei)
      .map(d => ({
        id: str(d.imei),
        name: str(d.deviceName || d.plate || d.name || d.imei),
        plate: d.plate ? str(d.plate) : null,
      }))
    await cache().set('device_list', JSON.stringify(devices), DEVICE_LIST_TTL_S)
    return devices
  },

  getLiveStatus: liveStatus,
}
