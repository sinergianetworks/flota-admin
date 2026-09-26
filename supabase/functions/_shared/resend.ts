// Configuración y envío de correos con Resend (API HTTP). Las edge functions
// no permiten SMTP por los puertos 25/587.
import { HttpError } from './http.ts'

export interface EmailConfig {
  apiKey: string
  from: string
  appUrl: string
  appName: string
}

// Lee los secrets de correo. Lanza 500 con la lista de los que faltan.
export function emailConfig(): EmailConfig {
  const get = (k: string) => (Deno.env.get(k) ?? '').trim()
  const cfg = {
    apiKey: get('RESEND_API_KEY'),
    from: get('EMAIL_FROM'),
    appUrl: get('APP_URL'),
    appName: get('APP_NAME') || 'Flota Admin',
  }
  const missing = [
    !cfg.apiKey && 'RESEND_API_KEY',
    !cfg.from && 'EMAIL_FROM',
    !cfg.appUrl && 'APP_URL',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new HttpError(500, `Faltan secrets para enviar correos: ${missing.join(', ')}`)
  }
  return cfg
}

export interface OutgoingEmail {
  to: string[]
  subject: string
  html: string
  text: string
}

export async function sendEmail(cfg: EmailConfig, email: OutgoingEmail): Promise<void> {
  // RESEND_API_URL solo existe para apuntar a un servidor simulado en los tests.
  const url = Deno.env.get('RESEND_API_URL') || 'https://api.resend.com/emails'
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: email.to, subject: email.subject, html: email.html, text: email.text }),
  })
  if (!res.ok) {
    throw new Error(`Resend (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
}
