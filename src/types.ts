export type UserRole = 'admin' | 'driver'

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrador',
  driver: 'Conductor',
}

export interface Profile {
  id: string
  email: string
  full_name: string
  phone: string | null
  role: UserRole
  active: boolean
  created_at: string
}

export interface Vehicle {
  id: string
  name: string
  plate: string | null
  chassis_number: string | null
  // Rutas dentro de los buckets privados (no URLs): se firman al mostrarlas.
  photo_url: string | null
  insurance_doc_url: string | null
  gps_provider: string | null
  gps_device_id: string | null
  odometer_offset: number
  assigned_driver_id: string | null
  next_maintenance_km: number | null
  next_maintenance_date: string | null
  notes: string | null
  active: boolean
  insurance_company: string | null
  insurance_policy: string | null
  insurance_expiry: string | null
  driver: { full_name: string } | null
}

export type VehicleLogType = 'maintenance' | 'repair' | 'part' | 'fuel' | 'note'

// Estado en vivo normalizado que devuelve la edge function gps-status,
// independiente del proveedor GPS.
export interface LiveStatus {
  vehicleId: string
  online: boolean
  engineOn: boolean
  speedKmh: number
  lat: number | null
  lng: number | null
  positionTime: string | null
  lastSeen: string | null
  // false si la posición es vieja respecto al último latido: la velocidad no es confiable.
  positionFresh: boolean
}

export interface GpsDevice {
  id: string
  name: string
  plate?: string | null
}

export interface GpsProviderInfo {
  id: string
  name: string
  configured: boolean
}
