// send-weekly-report: resumen semanal de todos los vehículos activos.
//
// Modo programado (pg_cron, header x-cron-secret): el día configurado
// (fleet_settings.weekly_report_day, 1 = lunes), a partir de las 7:00 en
// APP_TIMEZONE, una vez. Cubre los 7 días anteriores. Ver _shared/notify.ts.
// Modo prueba (admin con sesión, body { test: true }): lo envía solo al admin
// que llama, cualquier día y hora, sin registrar.
import { json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin } from '../_shared/supabase.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { addDays, appTimeZone, dateInTz, hourInTz, isoWeekday } from '../_shared/time.ts'
import { buildWeeklyReport, type WeeklyVehicle } from '../_shared/weekly_report.ts'
import { buildWeeklyEmail } from '../_shared/weekly_email.ts'
import { deliver, loadNotificationSettings, resendConfigured, SEND_HOUR } from '../_shared/notify.ts'

interface Deps {
  now: () => Date
}

export function createHandler(deps: Deps = { now: () => new Date() }) {
  return async (req: Request): Promise<Response> => {
    const db = adminClient()
    const fromCron = isCronRequest(req)
    const caller = fromCron ? null : await requireAdmin(req, db)
    const body = await readJson<{ test?: boolean }>(req)
    const test = !fromCron && body.test === true
    if (!fromCron && !test) throw new HttpError(400, 'Usa { "test": true } para enviar un reporte de prueba.')

    const tz = appTimeZone()
    const now = deps.now()
    const today = dateInTz(now, tz)

    if (!test) {
      if (hourInTz(now, tz) < SEND_HOUR) return json({ skipped: 'hour', today })
      if (!resendConfigured()) return json({ skipped: 'not_configured', today })
    }

    const settings = await loadNotificationSettings(db)
    if (!test) {
      if (!settings.weekly_report_enabled) return json({ skipped: 'disabled', today })
      if (isoWeekday(today) !== settings.weekly_report_day) return json({ skipped: 'not_today', today })
    }

    let testRecipients: string[] | undefined
    if (test) {
      if (!caller?.user.email) throw new HttpError(400, 'Tu usuario no tiene correo; no se puede enviar la prueba.')
      testRecipients = [caller.user.email]
    }

    return deliver(db, {
      kind: 'weekly',
      today,
      test,
      testRecipients,
      configuredRecipients: settings.notification_emails,
      prepare: async () => {
        const vRes = await db.from('vehicles')
          .select('id, name, plate, active, next_maintenance_km, next_maintenance_date, insurance_company, insurance_expiry, gps_device_id, driver:profiles(full_name)')
          .eq('active', true)
        if (vRes.error) throw new HttpError(500, vRes.error.message)

        // El kilometraje solo sirve para estimar días en vehículos con GPS
        // (ver reminders.ts); si ninguno tiene, no vale la pena consultarlo.
        const vehicles = (vRes.data ?? []) as unknown as WeeklyVehicle[]
        const gpsIds = vehicles.filter(v => v.gps_device_id).map(v => v.id)
        const [oRes, mRes] = await Promise.all([
          db.from('vehicle_odometer').select('vehicle_id, odometer_km, has_data'),
          gpsIds.length > 0
            ? db.from('vehicle_daily_mileage').select('vehicle_id, date, km')
                .gte('date', addDays(today, -28)).lt('date', today).in('vehicle_id', gpsIds)
            : Promise.resolve({ data: [] as { vehicle_id: string; date: string; km: number }[], error: null }),
        ])
        const err = oRes.error ?? mRes.error
        if (err) throw new HttpError(500, err.message)

        const report = buildWeeklyReport({ vehicles, odometers: oRes.data ?? [], mileage: mRes.data ?? [] }, settings, today)
        return {
          itemCount: report.rows.length,
          nothingToSend: report.rows.length === 0,
          render: cfg => buildWeeklyEmail(report, { ...cfg, weekday: settings.weekly_report_day }),
        }
      },
    })
  }
}
