// send-reminders: alerta diaria de mantenimiento (por km y por fecha).
//
// Modo programado (pg_cron, header x-cron-secret): a partir de las 7:00 en
// APP_TIMEZONE, una vez por día y solo si hay mantenimientos por vencer o
// vencidos. Ver _shared/notify.ts para la máquina de estados.
// Modo prueba (admin con sesión, body { test: true }): envía las alertas de hoy
// solo al admin que llama, a cualquier hora y sin registrar nada.
import { json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin } from '../_shared/supabase.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { addDays, appTimeZone, dateInTz, hourInTz } from '../_shared/time.ts'
import { averageKmPerDay, computeReminders } from '../_shared/reminders.ts'
import { buildReminderEmail } from '../_shared/reminder_email.ts'
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
    if (!fromCron && !test) throw new HttpError(400, 'Usa { "test": true } para enviar un correo de prueba.')

    const tz = appTimeZone()
    const now = deps.now()
    const today = dateInTz(now, tz)

    if (!test) {
      if (hourInTz(now, tz) < SEND_HOUR) return json({ skipped: 'hour', today })
      // Sin Resend configurado los correos están inactivos: no se reserva el día.
      if (!resendConfigured()) return json({ skipped: 'not_configured', today })
    }

    const settings = await loadNotificationSettings(db)
    // Desactivado: no se reserva ni registra, así reactivarlo más tarde sirve el mismo día.
    if (!test && !settings.email_reminders_enabled) return json({ skipped: 'disabled', today })

    let testRecipients: string[] | undefined
    if (test) {
      if (!caller?.user.email) throw new HttpError(400, 'Tu usuario no tiene correo; no se puede enviar la prueba.')
      testRecipients = [caller.user.email]
    }

    return deliver(db, {
      kind: 'daily',
      today,
      test,
      testRecipients,
      configuredRecipients: settings.notification_emails,
      prepare: async () => {
        const vRes = await db.from('vehicles')
          .select('id, name, plate, active, next_maintenance_km, next_maintenance_date, insurance_expiry, gps_device_id')
          .eq('active', true)
        if (vRes.error) throw new HttpError(500, vRes.error.message)

        // El kilometraje solo sirve para estimar días en vehículos con GPS
        // (ver reminders.ts); si ninguno tiene, no vale la pena consultarlo.
        const gpsIds = (vRes.data ?? []).filter(v => v.gps_device_id).map(v => v.id)
        const [oRes, mRes] = await Promise.all([
          db.from('vehicle_odometer').select('vehicle_id, odometer_km, has_data'),
          gpsIds.length > 0
            ? db.from('vehicle_daily_mileage').select('vehicle_id, date, km')
                .gte('date', addDays(today, -28)).lt('date', today).in('vehicle_id', gpsIds)
            : Promise.resolve({ data: [] as { vehicle_id: string; date: string; km: number }[], error: null }),
        ])
        const err = oRes.error ?? mRes.error
        if (err) throw new HttpError(500, err.message)

        const byVehicle = new Map<string, { date: string; km: number }[]>()
        for (const m of mRes.data ?? []) {
          const list = byVehicle.get(m.vehicle_id) ?? []
          list.push({ date: m.date, km: Number(m.km) })
          byVehicle.set(m.vehicle_id, list)
        }
        const averages = new Map<string, number>()
        for (const [id, rows] of byVehicle) {
          const avg = averageKmPerDay(rows, today)
          if (avg != null) averages.set(id, avg)
        }

        const items = computeReminders(vRes.data ?? [], oRes.data ?? [], settings, today, averages)
        return {
          itemCount: items.length,
          nothingToSend: items.length === 0,
          render: cfg => buildReminderEmail(items, { ...cfg, today }),
        }
      },
    })
  }
}
