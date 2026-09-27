// Kilometraje diario de varios vehículos, paginado.
//
// PostgREST limita cada consulta a max_rows filas (1000 por defecto). Con
// muchos vehículos o una ventana larga, vehicle_daily_mileage puede superar
// esa cantidad, así que se pide en páginas de 1000 hasta que una página
// devuelve menos: ahí se sabe que no queda nada más.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

export interface MileageRow {
  vehicle_id: string
  date: string
  km: number | string
}

const PAGE_SIZE = 1000

export async function fetchMileage(
  db: SupabaseClient,
  vehicleIds: string[],
  from: string,
  toExclusive: string,
): Promise<MileageRow[]> {
  if (vehicleIds.length === 0) return []

  const rows: MileageRow[] = []
  let offset = 0
  while (true) {
    const { data, error } = await db.from('vehicle_daily_mileage')
      .select('vehicle_id, date, km')
      .in('vehicle_id', vehicleIds)
      .gte('date', from)
      .lt('date', toExclusive)
      .order('vehicle_id')
      .order('date')
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new HttpError(500, error.message)

    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return rows
}
