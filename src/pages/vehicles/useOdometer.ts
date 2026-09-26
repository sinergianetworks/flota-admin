import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Vehicle } from '@/types'

export interface Odometer {
  km: number
  // 'gps': odómetro base + km diarios del GPS.
  // 'manual': mayor valor entre el odómetro base y la última lectura de la bitácora.
  source: 'gps' | 'manual'
  hasData: boolean
  // true si el valor mostrado sale de una lectura de la bitácora (no del odómetro base).
  fromLog: boolean
}

// Calcula el odómetro mostrado. `refreshKey` fuerza a recalcular (p. ej. tras
// sincronizar km o agregar una entrada en la bitácora).
export function useOdometer(vehicle: Vehicle, refreshKey: number): Odometer {
  const hasGps = !!vehicle.gps_provider && !!vehicle.gps_device_id
  const [extra, setExtra] = useState<{ key: string; value: number | null } | null>(null)
  const key = `${vehicle.id}:${hasGps}:${refreshKey}`

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (hasGps) {
        const { data } = await supabase
          .from('vehicle_daily_mileage')
          .select('km')
          .eq('vehicle_id', vehicle.id)
        const total = (data ?? []).reduce((s, r) => s + Number(r.km), 0)
        return data && data.length > 0 ? total : null
      }
      const { data } = await supabase
        .from('vehicle_log')
        .select('odometer_km')
        .eq('vehicle_id', vehicle.id)
        .not('odometer_km', 'is', null)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
      return data?.[0]?.odometer_km != null ? Number(data[0].odometer_km) : null
    }

    load().then(value => {
      if (!cancelled) setExtra({ key, value })
    })
    return () => { cancelled = true }
  }, [vehicle.id, hasGps, key])

  const base = Number(vehicle.odometer_offset) || 0
  const value = extra?.key === key ? extra.value : null

  if (hasGps) {
    return { km: base + (value ?? 0), source: 'gps', hasData: value !== null || base > 0, fromLog: false }
  }
  return {
    km: Math.max(base, value ?? 0),
    source: 'manual',
    hasData: value !== null || base > 0,
    fromLog: value !== null && value > base,
  }
}
