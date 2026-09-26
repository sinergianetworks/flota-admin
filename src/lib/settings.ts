import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// Umbrales de aviso de la instalación (tabla fleet_settings, una sola fila).
// Los mismos valores usa la función send-reminders para los correos.
export interface FleetSettings {
  maintenance_km_threshold: number
  maintenance_days_threshold: number
  insurance_days_threshold: number
  email_reminders_enabled: boolean
}

export const DEFAULT_SETTINGS: FleetSettings = {
  maintenance_km_threshold: 2000,
  maintenance_days_threshold: 15,
  insurance_days_threshold: 30,
  email_reminders_enabled: true,
}

const COLUMNS = 'maintenance_km_threshold, maintenance_days_threshold, insurance_days_threshold, email_reminders_enabled'

let cached: Promise<FleetSettings> | null = null

// Lee la configuración una vez por sesión de la página. `force` la vuelve a
// leer (después de guardar cambios). Ante un error devuelve los defaults sin
// cachearlos.
export function loadFleetSettings(force = false): Promise<FleetSettings> {
  if (!cached || force) {
    cached = Promise.resolve(supabase.from('fleet_settings').select(COLUMNS).single()).then(({ data, error }) => {
      if (error || !data) {
        cached = null
        return DEFAULT_SETTINGS
      }
      return { ...DEFAULT_SETTINGS, ...data } as FleetSettings
    })
  }
  return cached
}

export function useFleetSettings(): FleetSettings {
  const [settings, setSettings] = useState<FleetSettings>(DEFAULT_SETTINGS)
  useEffect(() => {
    let cancelled = false
    loadFleetSettings().then(s => { if (!cancelled) setSettings(s) })
    return () => { cancelled = true }
  }, [])
  return settings
}
