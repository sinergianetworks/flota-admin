// Contrato que implementa cada proveedor GPS.
//
// Para agregar un proveedor: crear un archivo en ./providers que exporte un
// GpsProvider y registrarlo en ./providers/index.ts (ver docs/PROVEEDORES_GPS.md).
// Las credenciales van SIEMPRE como secrets de las edge functions (Deno.env),
// nunca en el código ni en tablas.

export interface GpsDevice {
  // Identificador del equipo en el proveedor (lo que se guarda en vehicles.gps_device_id).
  id: string
  name: string
  plate?: string | null
}

// Estado en vivo normalizado de un equipo.
export interface DeviceStatus {
  deviceId: string
  online: boolean
  engineOn: boolean
  speedKmh: number
  lat: number | null
  lng: number | null
  // Tal como lo informa el proveedor (se muestra, no se usa para cálculos).
  positionTime: string | null
  lastSeen: string | null
  // false si la posición es vieja respecto al último latido: la velocidad no es confiable.
  positionFresh: boolean
}

export interface GpsProvider {
  // Id estable: es el valor que se guarda en vehicles.gps_provider.
  id: string
  // Nombre visible en la interfaz.
  name: string

  // true si las variables de entorno necesarias están definidas.
  isConfigured(): boolean

  // Verifica contra el proveedor que las credenciales funcionan. Lanza si no.
  validateCredentials(): Promise<void>

  // Km recorridos por cada equipo entre `from` y `to` (instantes UTC).
  // Devuelve { deviceId: km }. Los equipos sin datos pueden omitirse.
  getDailyMileage(deviceIds: string[], from: Date, to: Date): Promise<Record<string, number>>

  // Odómetro total que informa el equipo, en km. Opcional.
  getCurrentOdometer?(deviceIds: string[]): Promise<Record<string, number>>

  // Lista de equipos de la cuenta, para elegir al configurar un vehículo. Opcional.
  listDevices?(): Promise<GpsDevice[]>

  // Posición y estado en vivo. Opcional: sin esto el vehículo no aparece en el mapa.
  getLiveStatus?(deviceIds: string[]): Promise<DeviceStatus[]>
}
