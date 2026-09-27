import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildWeeklyEmail } from '../_shared/weekly_email.ts'
import type { WeeklyReport } from '../_shared/weekly_report.ts'

const OPTS = { appName: 'Transportes Ejemplo', appUrl: 'https://flota.ejemplo.test', weekday: 1 }

function report(p: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    periodFrom: '2026-09-21', periodTo: '2026-09-27',
    totals: { vehicles: 1, weekKm: 1234.5, alerts: 0 },
    attention: [],
    rows: [{
      vehicleId: 'a', name: 'Pickup', plate: 'AB-1', driver: 'Ana', odometerKm: 51176, weekKm: 1234.5,
      maintenance: { kind: 'km', remainingKm: 8824 }, insurance: { expiry: '2027-03-15', remainingDays: 168, company: 'Aseg' }, alerts: [],
    }],
    ...p,
  }
}

Deno.test('asunto con el período', () => {
  assertEquals(buildWeeklyEmail(report(), OPTS).subject, 'Transportes Ejemplo: reporte semanal — 21/09 al 27/09/2026')
})

Deno.test('resumen, sin alertas y tabla de vehículos', () => {
  const e = buildWeeklyEmail(report(), OPTS)
  assertStringIncludes(e.html, 'Sin alertas esta semana.')
  assertStringIncludes(e.html, '1.235 km') // km de la flota redondeados
  assertStringIncludes(e.html, '51.176 km')
  assertStringIncludes(e.html, 'faltan 8.824 km')
  assertStringIncludes(e.html, 'vence en 168 días (15/03/2027)')
  assertStringIncludes(e.html, 'Ana')
  assertStringIncludes(e.text, '- Pickup (AB-1) · Ana · 51.176 km · semana 1.235 km')
  assertStringIncludes(e.text, 'Se envía cada lunes')
})

Deno.test('sin GPS, sin odómetro y alertas', () => {
  const e = buildWeeklyEmail(report({
    totals: { vehicles: 1, weekKm: 0, alerts: 1 },
    attention: [{ vehicleId: 'a', vehicleName: 'Pickup', plate: 'AB-1', kind: 'insurance', remaining: -2, overdue: true, dueDate: '2026-09-26' }],
    rows: [{ ...report().rows[0], weekKm: null, odometerKm: null, maintenance: null,
      insurance: { expiry: '2026-09-26', remainingDays: -2, company: null },
      alerts: [{ vehicleId: 'a', vehicleName: 'Pickup', plate: 'AB-1', kind: 'insurance', remaining: -2, overdue: true, dueDate: '2026-09-26' }] }],
  }), OPTS)
  assertStringIncludes(e.html, 'sin GPS')
  assertStringIncludes(e.html, 'Vencidos (1)')
  assertStringIncludes(e.html, 'vencido hace 2 días (26/09/2026)')
  assert(!e.html.includes('Sin alertas esta semana.'))
})

Deno.test('escapa HTML', () => {
  const e = buildWeeklyEmail(report({ rows: [{ ...report().rows[0], name: '<b>x</b>', driver: '<i>y</i>' }] }), OPTS)
  assert(!e.html.includes('<b>x</b>'))
  assertStringIncludes(e.html, '&lt;i&gt;y&lt;/i&gt;')
})
