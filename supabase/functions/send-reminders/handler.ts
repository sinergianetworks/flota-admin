// send-reminders: correo diario de vencimientos para los admins activos.
//
// Modo programado (pg_cron, header x-cron-secret): envía una sola vez por
// día, en la primera ejecución a partir de las 7:00 en APP_TIMEZONE. Si falla,
// la ejecución de la hora siguiente reintenta.
// Modo prueba (admin con sesión, body { test: true }): envía los avisos de hoy
// solo al admin que llama, a cualquier hora y sin registrar nada.
import { json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin } from '../_shared/supabase.ts'
import { isCronRequest } from '../_shared/cron.ts'
import { appTimeZone, dateInTz, hourInTz } from '../_shared/time.ts'
import { computeReminders, type ReminderSettings } from '../_shared/reminders.ts'
import { buildReminderEmail } from '../_shared/reminder_email.ts'
import { emailConfig, sendEmail, ResendHttpError } from '../_shared/resend.ts'

const SEND_HOUR = 7

type Status = 'sending' | 'sent' | 'nothing_to_send' | 'disabled' | 'error'

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

    const log = async (status: Status, recipients: string[], itemCount: number, error: string | null = null) => {
      const { error: e } = await db.from('reminder_log').upsert(
        { local_date: today, status, recipients, item_count: itemCount, error },
        { onConflict: 'local_date' },
      )
      if (e) console.error('send-reminders: no se pudo registrar el envío', e.message)
    }

    if (!test) {
      if (hourInTz(now, tz) < SEND_HOUR) return json({ skipped: 'hour', today })
      // Reclama el día de forma atómica: true solo si no existía o quedó en error.
      // Un 'sending' colgado cuenta como "posiblemente enviado" y no se reintenta.
      const { data: claimed, error: cErr } = await db.rpc('flota_claim_reminder_day', { p_date: today })
      if (cErr) throw new HttpError(500, `No se pudo reservar el envío del día: ${cErr.message}`)
      if (!claimed) return json({ skipped: 'already_sent', today })
    }

    const { data: settingsRow, error: sErr } = await db
      .from('fleet_settings')
      .select('maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled')
      .single()
    if (sErr || !settingsRow) throw new HttpError(500, `No se pudo leer la configuración: ${sErr?.message ?? 'sin fila'}`)

    if (!test && !settingsRow.email_reminders_enabled) {
      await log('disabled', [], 0)
      return json({ status: 'disabled', today })
    }

    const [{ data: vehicles, error: vErr }, { data: odometers, error: oErr }] = await Promise.all([
      db.from('vehicles').select('id, name, plate, active, next_maintenance_km, next_maintenance_date, insurance_expiry').eq('active', true),
      db.from('vehicle_odometer').select('vehicle_id, odometer_km, has_data'),
    ])
    if (vErr || oErr) throw new HttpError(500, (vErr ?? oErr)!.message)

    const items = computeReminders(vehicles ?? [], odometers ?? [], settingsRow as ReminderSettings, today)

    if (!test && items.length === 0) {
      await log('nothing_to_send', [], 0)
      return json({ status: 'nothing_to_send', today })
    }

    let recipients: string[]
    if (test) {
      recipients = caller?.user.email ? [caller.user.email] : []
    } else {
      const { data: admins } = await db.from('profiles').select('email').eq('role', 'admin').eq('active', true)
      recipients = (admins ?? []).map(a => a.email).filter(Boolean)
    }

    // Si falla antes de llamar a Resend, o Resend responde con error HTTP, el
    // correo NO salió: el día queda en 'error' y la hora siguiente reintenta.
    // Un timeout o corte de red DURANTE el envío es "posiblemente enviado": el día
    // queda en 'sending' y no se reintenta, para no duplicar el correo.
    let attempted = false
    try {
      if (recipients.length === 0) throw new HttpError(500, 'No hay administradores activos con correo.')
      const cfg = emailConfig()
      const email = buildReminderEmail(items, { appName: cfg.appName, appUrl: cfg.appUrl, today })
      attempted = true
      await sendEmail(cfg, { to: recipients, ...email })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const possiblySent = attempted && !(e instanceof ResendHttpError)
      if (!test) await log(possiblySent ? 'sending' : 'error', recipients, items.length, message)
      throw new HttpError(502, message)
    }

    if (!test) await log('sent', recipients, items.length)
    return json({ status: 'sent', items: items.length, recipients: recipients.length, test, today })
  }
}
