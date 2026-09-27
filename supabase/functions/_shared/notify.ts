// Flujo común de los correos programados (alerta diaria y reporte semanal):
// configuración, destinatarios, reserva atómica del día por tipo, envío por
// Resend y registro en reminder_log.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { json, HttpError } from './http.ts'
import { emailConfig, sendEmail, ResendHttpError } from './resend.ts'
import type { EmailContent } from './reminder_email.ts'

export const SEND_HOUR = 7

export type NotificationKind = 'daily' | 'weekly'
type Status = 'sending' | 'sent' | 'nothing_to_send' | 'error'

export interface NotificationSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
  email_reminders_enabled: boolean
  notification_emails: string[]
  weekly_report_enabled: boolean
  weekly_report_day: number
}

export function resendConfigured(): boolean {
  return (Deno.env.get('RESEND_API_KEY') ?? '').trim() !== ''
}

export async function loadNotificationSettings(db: SupabaseClient): Promise<NotificationSettings> {
  const { data, error } = await db
    .from('fleet_settings')
    .select('maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled, notification_emails, weekly_report_enabled, weekly_report_day')
    .single()
  if (error || !data) throw new HttpError(500, `No se pudo leer la configuración: ${error?.message ?? 'sin fila'}`)
  return { ...data, notification_emails: data.notification_emails ?? [] } as NotificationSettings
}

// La lista configurada o, si está vacía, los administradores activos.
export async function resolveRecipients(db: SupabaseClient, configured: string[]): Promise<string[]> {
  const list = [...new Set((configured ?? []).map(e => e.trim()).filter(Boolean))]
  if (list.length > 0) return list
  const { data, error } = await db.from('profiles').select('email').eq('role', 'admin').eq('active', true)
  if (error) throw new HttpError(500, `No se pudo leer los administradores: ${error.message}`)
  const admins = (data ?? []).map((a: { email: string }) => a.email).filter(Boolean)
  if (admins.length === 0) throw new HttpError(500, 'No hay destinatarios: la lista está vacía y no hay administradores activos con correo.')
  return admins
}

export interface Prepared {
  itemCount: number
  nothingToSend: boolean
  render: (cfg: { appName: string; appUrl: string }) => EmailContent
}

export interface DeliverOptions {
  kind: NotificationKind
  today: string
  test: boolean
  // Modo prueba: a quién se envía (el admin que lo pidió).
  testRecipients?: string[]
  // Destinatarios configurados (modo programado).
  configuredRecipients: string[]
  prepare: () => Promise<Prepared>
}

// Modo programado: reserva el día (kind, fecha) y ejecuta el envío con la
// máquina de estados:
// - falla antes de llamar a Resend, o Resend responde con error HTTP → 'error'
//   (la hora siguiente reintenta);
// - timeout o corte de red con el envío ya intentado → 'sending' ("posiblemente
//   enviado"; no se reintenta, para no duplicar);
// - éxito → 'sent' (registro best-effort: si falla, no se reenvía).
// Modo prueba: no reserva ni registra; envía a testRecipients.
export async function deliver(db: SupabaseClient, o: DeliverOptions): Promise<Response> {
  const { kind, today, test } = o

  const log = async (status: Status, recipients: string[], itemCount: number, error: string | null = null) => {
    const { error: e } = await db.from('reminder_log').upsert(
      { kind, local_date: today, status, recipients, item_count: itemCount, error },
      { onConflict: 'kind,local_date' },
    )
    if (e) throw new HttpError(500, `No se pudo registrar el envío: ${e.message}`)
  }
  const logBestEffort = async (status: Status, recipients: string[], itemCount: number, error: string | null = null) => {
    try {
      await log(status, recipients, itemCount, error)
    } catch (e) {
      console.error(`${kind}: no se pudo registrar el envío`, e instanceof Error ? e.message : e)
    }
  }

  if (!test) {
    const { data: claimed, error } = await db.rpc('flota_claim_notification', { p_kind: kind, p_date: today })
    if (error) throw new HttpError(500, `No se pudo reservar el envío del día: ${error.message}`)
    if (!claimed) return json({ skipped: 'already_sent', kind, today })
  }

  let attempted = false
  let itemCount = 0
  let recipients: string[] = []
  try {
    const prepared = await o.prepare()
    itemCount = prepared.itemCount

    if (!test && prepared.nothingToSend) {
      await log('nothing_to_send', [], itemCount)
      return json({ status: 'nothing_to_send', kind, today })
    }

    recipients = test ? (o.testRecipients ?? []) : await resolveRecipients(db, o.configuredRecipients)
    if (recipients.length === 0) throw new HttpError(400, 'No hay destinatarios para la prueba.')

    const cfg = emailConfig()
    const email = prepared.render({ appName: cfg.appName, appUrl: cfg.appUrl })
    attempted = true
    await sendEmail(cfg, { to: recipients, ...email })

    if (!test) await logBestEffort('sent', recipients, itemCount)
    return json({ status: 'sent', kind, items: itemCount, recipients: recipients.length, test, today })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const possiblySent = attempted && !(e instanceof ResendHttpError)
    if (!test) await logBestEffort(possiblySent ? 'sending' : 'error', recipients, itemCount, message)
    if (possiblySent) throw new HttpError(502, message)
    if (e instanceof HttpError) throw e
    if (e instanceof ResendHttpError) throw new HttpError(502, message)
    throw new HttpError(500, message)
  }
}
