// Pruebas del proveedor Tracksolid contra un servidor simulado que hace de
// API de Tracksolid y de PostgREST (tabla gps_cache).
import { assert, assertEquals } from 'jsr:@std/assert@1'

const PORT = 54871
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${PORT}`)
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_test' }))
Deno.env.set('TRACKSOLID_APP_KEY', 'KEY')
Deno.env.set('TRACKSOLID_APP_SECRET', 'SECRET')
Deno.env.set('TRACKSOLID_USER_ID', 'usuario')
Deno.env.set('TRACKSOLID_USER_PWD_MD5', 'e10adc3949ba59abbe56e057f20f883e')
Deno.env.set('TRACKSOLID_BASE_URL', `http://127.0.0.1:${PORT}/route/rest`)

const { tracksolid, signParams, parseMileage, parseStatus } = await import('../_shared/gps/providers/tracksolid.ts')

Deno.test('firma MD5 idéntica al algoritmo anterior', async () => {
  const sign = await signParams({
    app_key: 'KEY', format: 'json', method: 'jimi.user.device.list', sign_method: 'md5',
    timestamp: '2026-09-26 12:00:00', v: '1.0', target: 'demo',
  }, 'SECRET')
  assertEquals(sign, '111013C82746E754E173E90AD4506DA4')
})

Deno.test('parseMileage: prefiere totales por equipo y suma tramos si faltan', () => {
  const km = parseMileage({
    code: 0,
    data: [{ imei: 'A', totalMileage: '12500' }],
    result: [
      { imei: 'A', distance: '999999' },
      { imei: 'B', distance: '1000' },
      { imei: 'B', distance: '2500' },
    ],
  })
  assertEquals(km, { A: 12.5, B: 3.5 })
})

Deno.test('parseStatus: estados y frescura de la posición', () => {
  const s = parseStatus({
    imei: 'A', status: '1', accStatus: '1', speed: '48', lat: '18.5', lng: '-69.9',
    gpsTime: '2026-09-26 10:00:00', hbTime: '2026-09-26 10:20:00',
  })
  assertEquals(s.online, true)
  assertEquals(s.engineOn, true)
  assertEquals(s.speedKmh, 48)
  assertEquals(s.lat, 18.5)
  assertEquals(s.positionFresh, false) // 20 min entre posición y latido
  const off = parseStatus({ imei: 'B', status: 0, accStatus: 0 })
  assertEquals(off.online, false)
  assertEquals(off.lat, null)
})

Deno.test('flujo con servidor simulado: token en caché, reintento, lotes y equipos', async () => {
  const cacheRows = new Map<string, { value: string; expires_at: string }>()
  const calls: Record<string, string>[] = []
  let tokenCount = 0
  let rejectTokenOnce = ''

  const server = Deno.serve({ port: PORT, onListen() {} }, async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/rest/v1/gps_cache') {
      assertEquals(req.headers.get('apikey'), 'sb_secret_test')
      const key = url.searchParams.get('key')?.replace('eq.', '') ?? ''
      if (req.method === 'GET') {
        const row = cacheRows.get(key)
        return Response.json(row ?? null, { status: row ? 200 : 406 })
      }
      if (req.method === 'POST') {
        const body = await req.json()
        for (const r of Array.isArray(body) ? body : [body]) cacheRows.set(r.key, r)
        return new Response(null, { status: 201 })
      }
      if (req.method === 'DELETE') { cacheRows.delete(key); return new Response(null, { status: 204 }) }
    }
    if (url.pathname === '/route/rest') {
      const p = Object.fromEntries(new URLSearchParams(await req.text()))
      calls.push(p)
      const { sign, ...rest } = p
      assertEquals(sign, await signParams(rest, 'SECRET'))
      if (p.method === 'jimi.oauth.token.get') {
        tokenCount++
        return Response.json({ code: 0, result: { accessToken: `tok${tokenCount}` } })
      }
      if (p.access_token === rejectTokenOnce) {
        rejectTokenOnce = ''
        return Response.json({ code: 1004, message: 'token invalid' })
      }
      if (p.method === 'jimi.device.track.mileage') {
        const imeis = p.imeis.split(',')
        return Response.json({ code: 0, data: imeis.map((imei: string) => ({ imei, totalMileage: '1000' })) })
      }
      if (p.method === 'jimi.user.device.list') {
        assertEquals(p.target, 'usuario')
        return Response.json({ code: 0, result: [{ imei: '111', deviceName: 'Camión', plate: 'AB-1' }] })
      }
    }
    return new Response('not found', { status: 404 })
  })

  try {
    assert(tracksolid.isConfigured())

    // 120 equipos → 3 llamadas de 50/50/20, un solo token
    const ids = Array.from({ length: 120 }, (_, i) => `IMEI${i}`)
    const from = new Date('2026-09-25T04:00:00Z')
    const to = new Date('2026-09-26T03:59:59Z')
    const km = await tracksolid.getDailyMileage(ids, from, to)
    assertEquals(Object.keys(km).length, 120)
    assertEquals(km.IMEI0, 1)
    const mileageCalls = calls.filter(c => c.method === 'jimi.device.track.mileage')
    assertEquals(mileageCalls.map(c => c.imeis.split(',').length), [50, 50, 20])
    assertEquals(mileageCalls[0].begin_time, '2026-09-25 04:00:00')
    assertEquals(mileageCalls[0].end_time, '2026-09-26 03:59:59')
    assertEquals(tokenCount, 1)
    assertEquals(cacheRows.get('token')?.value, 'tok1')

    // Token de caché rechazado → pide uno nuevo y reintenta una vez
    rejectTokenOnce = 'tok1'
    const devices = await tracksolid.listDevices!()
    assertEquals(devices, [{ id: '111', name: 'Camión', plate: 'AB-1' }])
    assertEquals(tokenCount, 2)
    assert(cacheRows.has('device_list'))

    // Segunda consulta de equipos: sale de la caché, sin llamar a la API
    const before = calls.length
    await tracksolid.listDevices!()
    assertEquals(calls.length, before)
  } finally {
    await server.shutdown()
  }
})
