// Autorización de llamadas de pg_cron: header x-cron-secret igual al secret
// SYNC_CRON_SECRET (mín. 16 caracteres), comparado en tiempo constante.

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

export function isCronRequest(req: Request): boolean {
  const secret = (Deno.env.get('SYNC_CRON_SECRET') ?? '').trim()
  const sent = req.headers.get('x-cron-secret') ?? ''
  return secret.length >= 16 && safeEqual(sent, secret)
}
