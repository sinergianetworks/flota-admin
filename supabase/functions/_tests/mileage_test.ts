// Pagina vehicle_daily_mileage: PostgREST limita a 1000 filas (max_rows) por
// consulta, así que fetchMileage debe pedir páginas de 1000 hasta agotarlas.
import { assertEquals } from 'jsr:@std/assert@1'

const PORT = 54877
const BASE = `http://127.0.0.1:${PORT}`
Deno.env.set('SUPABASE_URL', BASE)
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: 'sb_secret_test' }))

const { fetchMileage } = await import('../_shared/mileage.ts')
const { adminClient } = await import('../_shared/supabase.ts')

const TOTAL_ROWS = 2500

// 2500 filas ordenadas por vehicle_id y luego por date, como las devolvería
// la base de datos real.
const allRows = Array.from({ length: TOTAL_ROWS }, (_, i) => ({
  vehicle_id: i < TOTAL_ROWS / 2 ? 'v1' : 'v2',
  date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
  km: 10,
}))

const state = { requests: 0 }

const server = Deno.serve({ port: PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  if (url.pathname !== '/rest/v1/vehicle_daily_mileage') return new Response('not found', { status: 404 })

  state.requests++

  const select = url.searchParams.get('select') ?? ''
  if (select !== 'vehicle_id,date,km') return new Response(`select mal formado: ${select}`, { status: 400 })

  const vehicleId = url.searchParams.get('vehicle_id') ?? ''
  if (!vehicleId.startsWith('in.(')) return new Response('falta vehicle_id in.(...)', { status: 400 })

  const dates = url.searchParams.getAll('date')
  if (dates[0] !== 'gte.2026-01-01' || dates[1] !== 'lt.2026-02-01') {
    return new Response('faltan filtros de fecha', { status: 400 })
  }

  if (url.searchParams.get('order') !== 'vehicle_id.asc,date.asc') {
    return new Response('falta el order por vehicle_id y date', { status: 400 })
  }

  const offset = Number(url.searchParams.get('offset') ?? '0')
  const limit = Number(url.searchParams.get('limit') ?? '0')
  if (!Number.isFinite(offset) || !Number.isFinite(limit) || limit <= 0) {
    return new Response('faltan offset/limit', { status: 400 })
  }

  return Response.json(allRows.slice(offset, offset + limit))
})

Deno.test({ name: 'fetchMileage', sanitizeOps: false, sanitizeResources: false, async fn(t) {
  try {
    await t.step('pagina hasta agotar las 2500 filas en 3 páginas', async () => {
      state.requests = 0
      const db = adminClient()
      const rows = await fetchMileage(db, ['v1', 'v2'], '2026-01-01', '2026-02-01')
      assertEquals(rows.length, TOTAL_ROWS)
      assertEquals(state.requests, 3)
    })

    await t.step('sin vehículos: no hace ninguna consulta', async () => {
      state.requests = 0
      const db = adminClient()
      const rows = await fetchMileage(db, [], '2026-01-01', '2026-02-01')
      assertEquals(rows, [])
      assertEquals(state.requests, 0)
    })
  } finally {
    await server.shutdown()
  }
} })
