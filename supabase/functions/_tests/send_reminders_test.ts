// Simula PostgREST, Auth y Resend en un servidor local y ejercita el handler
// en sus modos programado y de prueba.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'

const PORT = 54873
const BASE = `http://127.0.0.1:${PORT}`
Deno.env.set('SUPABASE_URL', BASE)
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_test' }))
Deno.env.set('APP_TIMEZONE', 'America/La_Paz') // UTC-4 fijo
Deno.env.set('SYNC_CRON_SECRET', 'secreto-de-prueba-123456')
Deno.env.set('RESEND_API_URL', `${BASE}/resend/emails`)
Deno.env.set('RESEND_API_KEY', 're_test')
Deno.env.set('EMAIL_FROM', 'Flota <avisos@ejemplo.test>')
Deno.env.set('APP_URL', 'https://flota.ejemplo.test')

const { createHandler } = await import('../send-reminders/handler.ts')
const { withErrors } = await import('../_shared/http.ts')

// ── Estado simulado ──────────────────────────────────────────
const state = {
  settings: {
    maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30,
    email_reminders_enabled: true,
    notification_emails: [] as string[], weekly_report_enabled: true, weekly_report_day: 1,
  },
  vehicles: [
    { id: 'v1', name: 'Pickup', plate: 'AB-1', active: true, next_maintenance_km: 10500, next_maintenance_date: null, insurance_expiry: '2026-09-20' },
    { id: 'v2', name: 'Sedán', plate: null, active: true, next_maintenance_km: null, next_maintenance_date: null, insurance_expiry: null },
  ],
  odometers: [{ vehicle_id: 'v1', odometer_km: 10000, has_data: true }],
  mileage: [] as { vehicle_id: string; date: string; km: number }[],
  admins: [{ email: 'a1@ejemplo.test' }, { email: 'a2@ejemplo.test' }],
  log: new Map<string, Record<string, unknown>>(),
  emails: [] as Record<string, unknown>[],
  resendFails: false,
  // Camino del REST que debe responder 500, para simular un error de base de
  // datos en ese paso concreto.
  failEndpoint: null as string | null,
}

function resetState() {
  state.log.clear()
  state.emails = []
  state.resendFails = false
  state.failEndpoint = null
  state.settings.email_reminders_enabled = true
  state.settings.notification_emails = []
  state.mileage = []
}

const server = Deno.serve({ port: PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  const single = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const one = (row: unknown) => single ? (row ? Response.json(row) : new Response(null, { status: 406 })) : Response.json(row ? [row] : [])

  if (url.pathname === '/resend/emails') {
    assertEquals(req.headers.get('authorization'), 'Bearer re_test')
    if (state.resendFails) return new Response('{"message":"dominio no verificado"}', { status: 403 })
    state.emails.push(await req.json())
    return Response.json({ id: 'email_1' })
  }
  if (url.pathname === '/auth/v1/user') {
    const auth = req.headers.get('authorization')
    if (auth === 'Bearer jwt-admin') return Response.json({ id: 'u-admin', email: 'yo@ejemplo.test' })
    if (auth === 'Bearer jwt-driver') return Response.json({ id: 'u-driver', email: 'chofer@ejemplo.test' })
    if (auth === 'Bearer jwt-sinmail') return Response.json({ id: 'u-sinmail', email: null })
    return Response.json({ message: 'invalid' }, { status: 401 })
  }

  // Simula un error de base de datos en el paso indicado por el test.
  if (state.failEndpoint && url.pathname === state.failEndpoint) {
    return Response.json({ message: 'boom' }, { status: 500 })
  }

  switch (url.pathname) {
    case '/rest/v1/fleet_settings': return one(state.settings)
    case '/rest/v1/vehicles': {
      if (url.searchParams.get('active') !== 'eq.true') return new Response('falta active=eq.true', { status: 400 })
      return Response.json(state.vehicles)
    }
    case '/rest/v1/vehicle_odometer': return Response.json(state.odometers)
    case '/rest/v1/vehicle_daily_mileage': return Response.json(state.mileage)
    case '/rest/v1/profiles': {
      const id = url.searchParams.get('id')
      if (id === 'eq.u-admin') return one({ role: 'admin', active: true })
      if (id === 'eq.u-driver') return one({ role: 'driver', active: true })
      if (id === 'eq.u-sinmail') return one({ role: 'admin', active: true })
      if (url.searchParams.get('role') !== 'eq.admin' || url.searchParams.get('active') !== 'eq.true') {
        return new Response('falta role=eq.admin&active=eq.true', { status: 400 })
      }
      return Response.json(state.admins)
    }
    case '/rest/v1/rpc/flota_claim_notification': {
      // Misma semántica que la función SQL: reclama si no existe o está en error.
      const { p_kind, p_date } = await req.json()
      const key = `${p_kind}:${p_date}`
      const row = state.log.get(key)
      if (row && row.status !== 'error') return Response.json(false)
      state.log.set(key, { kind: p_kind, local_date: p_date, status: 'sending' })
      return Response.json(true)
    }
    case '/rest/v1/reminder_log': {
      if (req.method !== 'POST' || url.searchParams.get('on_conflict') !== 'kind,local_date' || !(req.headers.get('prefer') ?? '').includes('merge-duplicates')) {
        return new Response('upsert mal formado', { status: 400 })
      }
      const body = await req.json()
      for (const row of Array.isArray(body) ? body : [body]) state.log.set(`${row.kind}:${row.local_date}`, row)
      return new Response(null, { status: 201 })
    }
  }
  return new Response('not found', { status: 404 })
})

function cron() {
  return new Request('http://f/send-reminders', {
    method: 'POST', headers: { 'x-cron-secret': 'secreto-de-prueba-123456' }, body: '{}',
  })
}
function admin(token: string, body: Record<string, unknown> = { test: true }) {
  return new Request('http://f', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
}
const at = (iso: string) => withErrors(createHandler({ now: () => new Date(iso) }))
const SIETE = '2026-09-26T11:10:00Z' // 07:10 en UTC-4
const SEIS = '2026-09-26T10:10:00Z'  // 06:10 en UTC-4

Deno.test({ name: 'flujo de send-reminders', sanitizeOps: false, sanitizeResources: false, async fn(t) {
  try {
    await t.step('antes de las 7:00 no hace nada', async () => {
      resetState()
      const res = await (await at(SEIS)(cron())).json()
      assertEquals(res.skipped, 'hour')
      assertEquals(state.emails.length, 0)
    })

    await t.step('sin RESEND_API_KEY: no hace nada y no registra', async () => {
      resetState()
      const saved = Deno.env.get('RESEND_API_KEY')
      Deno.env.delete('RESEND_API_KEY')
      try {
        const res = await (await at(SIETE)(cron())).json()
        assertEquals(res.skipped, 'not_configured')
        assertEquals(state.emails.length, 0)
        assertEquals(state.log.size, 0)
      } finally {
        if (saved !== undefined) Deno.env.set('RESEND_API_KEY', saved)
      }
    })

    await t.step('a las 7:10 envía un correo a todos los admins y lo registra', async () => {
      resetState()
      const res = await (await at(SIETE)(cron())).json()
      assertEquals(res.status, 'sent')
      assertEquals(res.items, 1)
      assertEquals(state.emails.length, 1)
      assertEquals(state.emails[0].to, ['a1@ejemplo.test', 'a2@ejemplo.test'])
      assertStringIncludes(String(state.emails[0].subject), '1 alerta de mantenimiento — 26/09/2026')
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'sent')
    })

    await t.step('la siguiente hora no repite el envío', async () => {
      const res = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(res.skipped, 'already_sent')
      assertEquals(state.emails.length, 1)
    })

    await t.step('desactivado: no reserva ni registra', async () => {
      resetState()
      state.settings.email_reminders_enabled = false
      const res = await (await at(SIETE)(cron())).json()
      assertEquals(res.skipped, 'disabled')
      assertEquals(state.emails.length, 0)
      assertEquals(state.log.size, 0)
    })

    await t.step('sin avisos: registra y no envía', async () => {
      resetState()
      const saved = state.vehicles
      state.vehicles = [saved[1]]
      const res = await (await at(SIETE)(cron())).json()
      state.vehicles = saved
      assertEquals(res.status, 'nothing_to_send')
      assertEquals(state.emails.length, 0)
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'nothing_to_send')
    })

    await t.step('error de Resend: registra error y reintenta la hora siguiente', async () => {
      resetState()
      state.resendFails = true
      const res = await at(SIETE)(cron())
      assertEquals(res.status, 502)
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'error')
      assertStringIncludes(String(state.log.get('daily:2026-09-26')?.error), 'Resend (403)')
      state.resendFails = false
      const retry = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(retry.status, 'sent')
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'sent')
    })

    await t.step('corte de red al enviar: queda en sending y no se reintenta', async () => {
      resetState()
      // Puerto cerrado: la conexión se rechaza (error de red, no respuesta HTTP).
      Deno.env.set('RESEND_API_URL', 'http://127.0.0.1:1/emails')
      const res = await at(SIETE)(cron())
      Deno.env.set('RESEND_API_URL', `${BASE}/resend/emails`)
      assertEquals(res.status, 502)
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'sending')
      const retry = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(retry.skipped, 'already_sent')
      assertEquals(state.emails.length, 0)
    })

    await t.step('secreto equivocado y sin sesión: 401', async () => {
      const req = new Request('http://f', { method: 'POST', headers: { 'x-cron-secret': 'otro' }, body: '{}' })
      assertEquals((await at(SIETE)(req)).status, 401)
    })

    await t.step('prueba de un admin: solo a quien la pide, a cualquier hora y sin registrar', async () => {
      resetState()
      const res = await (await at(SEIS)(admin('jwt-admin'))).json()
      assertEquals(res.status, 'sent')
      assertEquals(res.test, true)
      assertEquals(state.emails[0].to, ['yo@ejemplo.test'])
      assertEquals(state.log.size, 0)
    })

    // La lectura de fleet_settings ocurre antes de reservar el día (ver
    // notify.ts): si falla, no queda ninguna reserva colgada y la hora
    // siguiente arranca de cero, sin necesitar un estado 'error' previo.
    await t.step('error leyendo la configuración: no reserva y reintenta la hora siguiente', async () => {
      resetState()
      state.failEndpoint = '/rest/v1/fleet_settings'
      try {
        const res = await at(SIETE)(cron())
        assertEquals(res.status, 500)
        assertEquals(state.log.size, 0)
      } finally {
        state.failEndpoint = null
      }
      const retry = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(retry.status, 'sent')
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'sent')
    })

    await t.step('error leyendo vehículos: registra error y reintenta la hora siguiente', async () => {
      resetState()
      state.failEndpoint = '/rest/v1/vehicles'
      try {
        const res = await at(SIETE)(cron())
        assertEquals(res.status, 500)
        assertEquals(state.log.get('daily:2026-09-26')?.status, 'error')
      } finally {
        state.failEndpoint = null
      }
      const retry = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(retry.status, 'sent')
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'sent')
    })

    await t.step('error leyendo administradores: registra error y reintenta la hora siguiente', async () => {
      resetState()
      state.failEndpoint = '/rest/v1/profiles'
      try {
        const res = await at(SIETE)(cron())
        assertEquals(res.status, 500)
        assertEquals(state.log.get('daily:2026-09-26')?.status, 'error')
        assertStringIncludes(String(state.log.get('daily:2026-09-26')?.error), 'administradores')
      } finally {
        state.failEndpoint = null
      }
      const retry = await (await at('2026-09-26T12:10:00Z')(cron())).json()
      assertEquals(retry.status, 'sent')
      assertEquals(state.log.get('daily:2026-09-26')?.status, 'sent')
    })

    await t.step('no-admin con sesión recibe 403', async () => {
      assertEquals((await at(SIETE)(admin('jwt-driver'))).status, 403)
    })

    await t.step('admin sin { test: true } recibe 400', async () => {
      assertEquals((await at(SIETE)(admin('jwt-admin', {}))).status, 400)
    })

    await t.step('admin sin correo pide una prueba: 400', async () => {
      assertEquals((await at(SIETE)(admin('jwt-sinmail'))).status, 400)
    })

    await t.step('prueba con recordatorios desactivados: envía igual', async () => {
      resetState()
      state.settings.email_reminders_enabled = false
      const res = await (await at(SIETE)(admin('jwt-admin'))).json()
      assertEquals(res.status, 'sent')
      assertEquals(state.emails.length, 1)
      assertEquals(state.log.size, 0)
    })

    await t.step('prueba sin avisos: se envía con el asunto de "sin alertas"', async () => {
      resetState()
      const saved = state.vehicles
      state.vehicles = [saved[1]]
      const res = await (await at(SIETE)(admin('jwt-admin'))).json()
      state.vehicles = saved
      assertEquals(res.status, 'sent')
      assertStringIncludes(String(state.emails[0].subject), 'sin alertas de mantenimiento')
      assertEquals(state.log.size, 0)
    })

    await t.step('destinatarios configurados reemplazan a los admins', async () => {
      resetState()
      state.settings.notification_emails = ['flota@ejemplo.test', 'jefe@ejemplo.test']
      const res = await (await at(SIETE)(cron())).json()
      assertEquals(res.status, 'sent')
      assertEquals(state.emails[0].to, ['flota@ejemplo.test', 'jefe@ejemplo.test'])
    })

    await t.step('estimación de días con el kilometraje de los últimos 28 días', async () => {
      resetState()
      // 14 días × 100 km → promedio 50 km/día; faltan 500 km → ≈ 10 días
      state.mileage = Array.from({ length: 14 }, (_, i) => ({ vehicle_id: 'v1', date: `2026-09-${String(12 + i).padStart(2, '0')}`, km: 100 }))
      await (await at(SIETE)(cron())).json()
      assertStringIncludes(String(state.emails[0].text), '≈ 10 días al ritmo actual')
    })

    await t.step('desactivado y reactivado el mismo día: la hora siguiente envía', async () => {
      resetState()
      state.settings.email_reminders_enabled = false
      assertEquals((await (await at(SIETE)(cron())).json()).skipped, 'disabled')
      state.settings.email_reminders_enabled = true
      assertEquals((await (await at('2026-09-26T12:10:00Z')(cron())).json()).status, 'sent')
    })
  } finally {
    await server.shutdown()
  }
} })
