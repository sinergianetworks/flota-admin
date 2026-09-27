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
    appName: (get('APP_NAME') || 'Flota Admin').replace(/[\r\n]+/g, ' ').trim(),
  }
  const missing = [
    !cfg.apiKey && 'RESEND_API_KEY',
    !cfg.from && 'EMAIL_FROM',
    !cfg.appUrl && 'APP_URL',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new HttpError(500, `Faltan secrets para enviar correos: ${missing.join(', ')}`)
  }
  if (!/^https?:\/\//i.test(cfg.appUrl)) {
    throw new HttpError(500, 'APP_URL debe empezar con http:// o https://')
  }
  return cfg
}

export interface OutgoingEmail {
  to: string[]
  subject: string
  html: string
  text: string
}

// Resend respondió y rechazó el envío: el correo NO se envió.
export class ResendHttpError extends Error {}

// Si `sendEmail` lanza ResendHttpError, el correo no se envió (Resend lo
// rechazó). Cualquier otro error (timeout, red) significa que puede haberse
// enviado igual: no sabemos si la petición llegó a Resend antes de fallar,
// así que se propaga tal cual, sin envolverlo.
export async function sendEmail(cfg: EmailConfig, email: OutgoingEmail): Promise<void> {
  // RESEND_API_URL solo existe para apuntar a un servidor simulado en los tests.
  const url = Deno.env.get('RESEND_API_URL') || 'https://api.resend.com/emails'
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: email.to, subject: email.subject, html: email.html, text: email.text }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new ResendHttpError(`Resend (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
}
