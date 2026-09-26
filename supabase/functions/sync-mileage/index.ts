// sync-mileage: guarda en vehicle_daily_mileage los km del día de cada
// vehículo con GPS. Upsert por (vehicle_id, date): re-sincronizar un día lo
// sobrescribe con el valor más reciente.
//
// Body (opcional): { date?: 'YYYY-MM-DD' | 'today' | 'yesterday', vehicle_id?: uuid }
// Por defecto sincroniza "ayer" en APP_TIMEZONE.
//
// Autorización (verify_jwt = false):
//   · pg_cron → header x-cron-secret igual al secret SYNC_CRON_SECRET
//   · un admin con sesión → header Authorization: Bearer <jwt>
import { serve, json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin } from '../_shared/supabase.ts'
import { appTimeZone, dayRangeUtc, resolveDate } from '../_shared/time.ts'
import { getProvider } from '../_shared/gps/providers/index.ts'
import { isCronRequest } from '../_shared/cron.ts'

interface Body {
  date?: string
  vehicle_id?: string
}

serve(async (req) => {
  const admin = adminClient()

  const fromCron = isCronRequest(req)
  if (!fromCron) await requireAdmin(req, admin)

  const tz = appTimeZone()
  const body = await readJson<Body>(req)
  const date = resolveDate(body.date, tz)
  const { from, to } = dayRangeUtc(date, tz)

  let query = admin
    .from('vehicles')
    .select('id, gps_provider, gps_device_id')
    .eq('active', true)
    .not('gps_device_id', 'is', null)
  if (body.vehicle_id) query = query.eq('id', body.vehicle_id)
  const { data: vehicles, error } = await query
  if (error) throw new HttpError(500, error.message)

  const byProvider = new Map<string, { id: string; deviceId: string }[]>()
  for (const v of vehicles ?? []) {
    const list = byProvider.get(v.gps_provider) ?? []
    list.push({ id: v.id, deviceId: v.gps_device_id })
    byProvider.set(v.gps_provider, list)
  }

  const rows: { vehicle_id: string; date: string; km: number; updated_at: string }[] = []
  const errors: string[] = []
  const now = new Date().toISOString()

  for (const [providerId, items] of byProvider) {
    const provider = getProvider(providerId)
    if (!provider) { errors.push(`Proveedor desconocido: ${providerId}`); continue }
    if (!provider.isConfigured()) { errors.push(`${provider.name} no está configurado`); continue }
    try {
      const km = await provider.getDailyMileage(items.map(i => i.deviceId), from, to)
      for (const item of items) {
        // Si el proveedor respondió pero no trae el equipo, ese día no se movió.
        rows.push({ vehicle_id: item.id, date, km: Math.round((km[item.deviceId] ?? 0) * 100) / 100, updated_at: now })
      }
    } catch (e) {
      console.error(`sync-mileage: ${providerId}`, e)
      errors.push(`${provider.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (rows.length > 0) {
    const { error: upErr } = await admin
      .from('vehicle_daily_mileage')
      .upsert(rows, { onConflict: 'vehicle_id,date' })
    if (upErr) throw new HttpError(500, upErr.message)
  }

  const result = { date, timezone: tz, from: from.toISOString(), to: to.toISOString(), synced: rows.length, errors }
  // 502 si había vehículos para sincronizar y ningún proveedor respondió.
  return json(result, rows.length === 0 && errors.length > 0 ? 502 : 200)
})
