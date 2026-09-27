// Simula PostgREST, Auth y Resend y ejercita send-weekly-report.
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'

const PORT = 54875
const BASE = `http://127.0.0.1:${PORT}`
Deno.env.set('SUPABASE_URL', BASE)
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_test' }))
Deno.env.set('APP_TIMEZONE', 'America/La_Paz')
Deno.env.set('SYNC_CRON_SECRET', 'secreto-de-prueba-123456')
Deno.env.set('RESEND_API_URL', `${BASE}/resend/emails`)
Deno.env.set('RESEND_API_KEY', 're_test')
Deno.env.set('EMAIL_FROM', 'Flota <avisos@ejemplo.test>')
Deno.env.set('APP_URL', 'https://flota.ejemplo.test')

const { createHandler } = await import('../send-weekly-report/handler.ts')
const { withErrors } = await import('../_shared/http.ts')

const state = {
  settings: {
    maintenance_km_threshold: 2000, maintenance_days_threshold: 15, insurance_days_threshold: 30,
    email_reminders_enabled: true, notification_emails: [] as string[], weekly_report_enabled: true, weekly_report_day: 1,
  },
  vehicles: [
    { id: 'v1', name: 'Pickup', plate: 'AB-1', active: true, next_maintenance_km: 60000, next_maintenance_date: null, insurance_company: 'Aseg', insurance_expiry: '2026-09-20', gps_device_id: '111', driver: { full_name: 'Ana' } },
    { id: 'v2', name: 'Sedan', plate: 'CD-2', active: true, next_maintenance_km: null, next_maintenance_date: null, insurance_company: null, insurance_expiry: null, gps_device_id: null, driver: null },
  ] as Record<string, unknown>[],
  odometers: [{ vehicle_id: 'v1', odometer_km: 51000, has_data: true }],
  mileage: [{ vehicle_id: 'v1', date: '2026-09-22', km: 120 }],
  admins: [{ email: 'a1@ejemplo.test' }],
  log: new Map<string, Record<string, unknown>>(),
  emails: [] as Record<string, unknown>[],
  // Último valor de vehicle_id que recibió el mock de vehicle_daily_mileage
  // (para verificar que solo se consultan los vehículos con GPS).
  mileageVehicleIdParam: null as string | null,
}

function resetState() {
  state.log.clear()
  state.emails = []
  state.settings.weekly_report_enabled = true
  state.settings.weekly_report_day = 1
  state.settings.notification_emails = []
  state.mileageVehicleIdParam = null
}

const server = Deno.serve({ port: PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  const single = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const one = (row: unknown) => single ? (row ? Response.json(row) : new Response(null, { status: 406 })) : Response.json(row ? [row] : [])

  if (url.pathname === '/resend/emails') {
    state.emails.push(await req.json())
    return Response.json({ id: 'email_1' })
  }
  if (url.pathname === '/auth/v1/user') {
    return req.headers.get('authorization') === 'Bearer jwt-admin'
      ? Response.json({ id: 'u-admin', email: 'yo@ejemplo.test' })
      : Response.json({ message: 'invalid' }, { status: 401 })
  }
  switch (url.pathname) {
    case '/rest/v1/fleet_settings': return one(state.settings)
    case '/rest/v1/vehicles': {
      if (url.searchParams.get('active') !== 'eq.true') return new Response('falta active', { status: 400 })
      const select = url.searchParams.get('select') ?? ''
      if (!select.includes('driver:profiles(full_name)')) return new Response('falta el embed de driver', { status: 400 })
      return Response.json(state.vehicles)
    }
    case '/rest/v1/vehicle_odometer': return Response.json(state.odometers)
    case '/rest/v1/vehicle_daily_mileage': {
      const gte = url.searchParams.getAll('date').find(v => v.startsWith('gte.'))
      const lt = url.searchParams.getAll('date').find(v => v.startsWith('lt.'))
      const vehicleId = url.searchParams.get('vehicle_id')
      if (!gte || !lt || !vehicleId || !vehicleId.startsWith('in.(')) return new Response('faltan filtros', { status: 400 })
      state.mileageVehicleIdParam = vehicleId
      return Response.json(state.mileage)
    }
    case '/rest/v1/profiles':
      if (url.searchParams.get('id') === 'eq.u-admin') return one({ role: 'admin', active: true })
      return Response.json(state.admins)
    case '/rest/v1/rpc/flota_claim_notification': {
      const { p_kind, p_date } = await req.json()
      const key = `${p_kind}:${p_date}`
      const row = state.log.get(key)
      if (row && row.status !== 'error') return Response.json(false)
      state.log.set(key, { kind: p_kind, local_date: p_date, status: 'sending' })
      return Response.json(true)
    }
    case '/rest/v1/reminder_log': {
      if (url.searchParams.get('on_conflict') !== 'kind,local_date') return new Response('on_conflict', { status: 400 })
      const body = await req.json()
      for (const row of Array.isArray(body) ? body : [body]) state.log.set(`${row.kind}:${row.local_date}`, row)
      return new Response(null, { status: 201 })
    }
  }
  return new Response('not found', { status: 404 })
})

const cron = () => new Request('http://f', { method: 'POST', headers: { 'x-cron-secret': 'secreto-de-prueba-123456' }, body: '{}' })
const at = (iso: string) => withErrors(createHandler({ now: () => new Date(iso) }))
const LUNES_0715 = '2026-09-28T11:15:00Z'  // 07:15 en UTC-4, lunes
const MARTES_0715 = '2026-09-29T11:15:00Z'

Deno.test({ name: 'flujo de send-weekly-report', sanitizeOps: false, sanitizeResources: false, async fn(t) {
  try {
    await t.step('antes de las 7:00 no hace nada', async () => {
      resetState()
      assertEquals((await (await at('2026-09-28T10:15:00Z')(cron())).json()).skipped, 'hour')
    })

    await t.step('otro día de la semana: not_today', async () => {
      resetState()
      assertEquals((await (await at(MARTES_0715)(cron())).json()).skipped, 'not_today')
      assertEquals(state.log.size, 0)
    })

    await t.step('desactivado: no reserva ni registra', async () => {
      resetState()
      state.settings.weekly_report_enabled = false
      assertEquals((await (await at(LUNES_0715)(cron())).json()).skipped, 'disabled')
      assertEquals(state.log.size, 0)
    })

    await t.step('sin Resend configurado: not_configured y no reserva', async () => {
      resetState()
      const previous = Deno.env.get('RESEND_API_KEY')
      Deno.env.delete('RESEND_API_KEY')
      try {
        assertEquals((await (await at(LUNES_0715)(cron())).json()).skipped, 'not_configured')
        assertEquals(state.log.size, 0)
      } finally {
        if (previous != null) Deno.env.set('RESEND_API_KEY', previous)
      }
    })

    await t.step('secreto de cron equivocado sin sesión: 401', async () => {
      resetState()
      const req = new Request('http://f', { method: 'POST', headers: { 'x-cron-secret': 'secreto-incorrecto' }, body: '{}' })
      const res = await at(LUNES_0715)(req)
      assertEquals(res.status, 401)
    })

    await t.step('zona horaria: domingo 22:00 en La Paz sigue siendo not_today', async () => {
      resetState()
      // 2026-09-28T02:00:00Z es domingo 22:00 en America/La_Paz (UTC-4).
      assertEquals((await (await at('2026-09-28T02:00:00Z')(cron())).json()).skipped, 'not_today')
      assertEquals(state.log.size, 0)
    })

    await t.step('el día configurado envía el reporte a los admins y lo registra', async () => {
      resetState()
      const res = await (await at(LUNES_0715)(cron())).json()
      assertEquals(res.status, 'sent')
      assertEquals(res.kind, 'weekly')
      assertEquals(state.emails[0].to, ['a1@ejemplo.test'])
      assertStringIncludes(String(state.emails[0].subject), 'reporte semanal — 21/09 al 27/09/2026')
      assertStringIncludes(String(state.emails[0].text), 'semana 120 km')
      assertEquals(state.log.get('weekly:2026-09-28')?.status, 'sent')
      // Filtro GPS: solo v1 tiene gps_device_id, así que solo él se consulta
      // en vehicle_daily_mileage; v2 aparece en el correo como "sin GPS".
      assertEquals(state.mileageVehicleIdParam, 'in.(v1)')
      assertStringIncludes(String(state.emails[0].text), 'sin GPS')
    })

    await t.step('no repite el mismo día', async () => {
      assertEquals((await (await at('2026-09-28T12:15:00Z')(cron())).json()).skipped, 'already_sent')
      assertEquals(state.emails.length, 1)
    })

    await t.step('día configurable: martes', async () => {
      resetState()
      state.settings.weekly_report_day = 2
      assertEquals((await (await at(MARTES_0715)(cron())).json()).status, 'sent')
    })

    await t.step('destinatarios configurados', async () => {
      resetState()
      state.settings.notification_emails = ['flota@ejemplo.test']
      await (await at(LUNES_0715)(cron())).json()
      assertEquals(state.emails[0].to, ['flota@ejemplo.test'])
    })

    await t.step('sin vehículos: nothing_to_send', async () => {
      resetState()
      const saved = state.vehicles
      state.vehicles = []
      const res = await (await at(LUNES_0715)(cron())).json()
      state.vehicles = saved
      assertEquals(res.status, 'nothing_to_send')
      assertEquals(state.emails.length, 0)
    })

    await t.step('prueba de un admin: cualquier día y hora, solo a quien la pide', async () => {
      resetState()
      const req = new Request('http://f', { method: 'POST', headers: { authorization: 'Bearer jwt-admin' }, body: '{"test":true}' })
      const res = await (await at(MARTES_0715)(req)).json()
      assertEquals(res.status, 'sent')
      assertEquals(state.emails[0].to, ['yo@ejemplo.test'])
      assertEquals(state.log.size, 0)
    })
  } finally {
    await server.shutdown()
  }
} })
