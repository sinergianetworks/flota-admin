import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildReminderEmail, describeItem } from '../_shared/reminder_email.ts'
import type { ReminderItem } from '../_shared/reminders.ts'

const OPTS = { appName: 'Transportes Ejemplo', appUrl: 'https://flota.ejemplo.test/', today: '2026-09-26' }
const base = { vehicleId: '1', vehicleName: 'Pickup', plate: 'AB-12' }

Deno.test('describeItem: textos en español', () => {
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 1234.5, overdue: false, dueKm: 60000 }),
    'faltan 1.235 km (a los 60.000 km)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: -300, overdue: true, dueKm: 60000 }),
    'pasado por 300 km (tocaba a los 60.000 km)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 0, overdue: true, dueKm: 60000 }),
    'llegó a los 60.000 km')
  assertEquals(describeItem({ ...base, kind: 'insurance', remaining: 7, overdue: false, dueDate: '2026-10-03' }),
    'vence en 7 días (03/10/2026)')
  assertEquals(describeItem({ ...base, kind: 'insurance', remaining: 1, overdue: false, dueDate: '2026-09-27' }),
    'vence en 1 día (27/09/2026)')
  assertEquals(describeItem({ ...base, kind: 'insurance', remaining: 0, overdue: true, dueDate: '2026-09-26' }),
    'vence hoy (26/09/2026)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_date', remaining: -6, overdue: true, dueDate: '2026-09-20' }),
    'vencido hace 6 días (20/09/2026)')
})

Deno.test('correo con avisos: asunto, secciones, botón y texto plano', () => {
  const items: ReminderItem[] = [
    { ...base, kind: 'maintenance_date', remaining: 0, overdue: true, dueDate: '2026-09-26' },
    { ...base, kind: 'maintenance_km', remaining: 800, overdue: false, dueKm: 60000 },
  ]
  const e = buildReminderEmail(items, OPTS)
  assertEquals(e.subject, 'Transportes Ejemplo: 2 alertas de mantenimiento — 26/09/2026')
  assertStringIncludes(e.html, 'Vencidos')
  assertStringIncludes(e.html, 'Próximos')
  assertStringIncludes(e.html, 'Mantenimiento (fecha)')
  assertStringIncludes(e.html, 'Mantenimiento (km)')
  assertStringIncludes(e.html, 'href="https://flota.ejemplo.test/vehiculos"')
  assertStringIncludes(e.text, 'VENCIDOS')
  assertStringIncludes(e.text, '- Pickup (AB-12) · Mantenimiento (fecha): vence hoy (26/09/2026)')
})

Deno.test('singular y sin avisos', () => {
  const one = buildReminderEmail([{ ...base, kind: 'maintenance_date', remaining: 5, overdue: false, dueDate: '2026-10-01' }], OPTS)
  assertEquals(one.subject, 'Transportes Ejemplo: 1 alerta de mantenimiento — 26/09/2026')
  assert(!one.html.includes('Vencidos'))
  const none = buildReminderEmail([], OPTS)
  assertEquals(none.subject, 'Transportes Ejemplo: sin alertas de mantenimiento — 26/09/2026')
  assertStringIncludes(none.text, 'No hay mantenimientos por vencer')
})

Deno.test('escapa HTML de los datos', () => {
  const e = buildReminderEmail([{ ...base, vehicleName: '<script>x</script>', kind: 'insurance', remaining: 1, overdue: false, dueDate: '2026-09-27' }], OPTS)
  assert(!e.html.includes('<script>'))
  assertStringIncludes(e.html, '&lt;script&gt;')
})

Deno.test('html: incluye meta charset y viewport en el head', () => {
  const e = buildReminderEmail([], OPTS)
  assertStringIncludes(e.html, '<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>')
})

Deno.test('texto plano: vehículo sin placa muestra solo el nombre, sin paréntesis', () => {
  const e = buildReminderEmail([{ vehicleId: '2', vehicleName: 'Camioneta', plate: null, kind: 'insurance', remaining: 1, overdue: false, dueDate: '2026-09-27' }], OPTS)
  assertStringIncludes(e.text, '- Camioneta · Seguro: vence en 1 día (27/09/2026)')
  assert(!e.text.includes('Camioneta ('))
})

Deno.test('html: escapa placa y appName con etiquetas', () => {
  const e = buildReminderEmail(
    [{ ...base, plate: '<b>AB-12</b>', kind: 'insurance', remaining: 1, overdue: false, dueDate: '2026-09-27' }],
    { ...OPTS, appName: '<b>Transportes</b>' })
  assert(!e.html.includes('<b>AB-12</b>'))
  assert(!e.html.includes('<b>Transportes</b>'))
  assertStringIncludes(e.html, '&lt;b&gt;AB-12&lt;/b&gt;')
  assertStringIncludes(e.html, '&lt;b&gt;Transportes&lt;/b&gt;')
})

Deno.test('describeItem: estimación de días en mantenimiento por km', () => {
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 700, overdue: false, dueKm: 126500, estimatedDays: 7 }),
    'faltan 700 km (≈ 7 días al ritmo actual; a los 126.500 km)')
  assertEquals(describeItem({ ...base, kind: 'maintenance_km', remaining: 50, overdue: false, dueKm: 126500, estimatedDays: 1 }),
    'faltan 50 km (≈ 1 día al ritmo actual; a los 126.500 km)')
})

Deno.test('pie del correo diario', () => {
  const e = buildReminderEmail([{ ...base, kind: 'maintenance_date', remaining: 3, overdue: false, dueDate: '2026-09-29' }], OPTS)
  assertStringIncludes(e.text, 'Recibes este aviso porque estás en la lista de avisos de la flota.')
})
