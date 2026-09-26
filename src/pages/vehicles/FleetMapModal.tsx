import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { LiveStatus, Vehicle } from '@/types'

interface Props {
  open: boolean
  onClose: () => void
  vehicles: Vehicle[]
  statuses: Record<string, LiveStatus>
}

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16']

function colorIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:18px;height:18px;border-radius:50%;
      background:${color};border:2.5px solid white;
      box-shadow:0 1px 5px rgba(0,0,0,0.35);
    "></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -12],
  })
}

type Positioned = LiveStatus & { lat: number; lng: number }

function positionOf(s: LiveStatus | undefined): Positioned | null {
  if (!s || s.lat == null || s.lng == null || (s.lat === 0 && s.lng === 0)) return null
  return s as Positioned
}

function MapController({
  vehicles,
  statuses,
  flyToId,
  onFlyComplete,
}: {
  vehicles: Vehicle[]
  statuses: Record<string, LiveStatus>
  flyToId: string | null
  onFlyComplete: () => void
}) {
  const map = useMap()

  useEffect(() => {
    // Corre al montar (cada vez que se abre el modal, porque MapContainer se
    // renderiza condicionalmente) y encuadra todos los vehículos con posición.
    const coords = vehicles
      .map(v => positionOf(statuses[v.id]))
      .filter((s): s is Positioned => s !== null)
      .map(s => [s.lat, s.lng] as [number, number])

    if (coords.length === 0) return
    if (coords.length === 1) map.setView(coords[0], 14)
    else map.fitBounds(L.latLngBounds(coords), { padding: [40, 40] })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flyToId) return
    const s = positionOf(statuses[flyToId])
    if (s) map.flyTo([s.lat, s.lng], 16)
    onFlyComplete()
  }, [flyToId, statuses, map, onFlyComplete])

  return null
}

export default function FleetMapModal({ open, onClose, vehicles, statuses }: Props) {
  const [flyToId, setFlyToId] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-5xl w-full p-0 overflow-hidden flex flex-col" style={{ height: '80vh' }}>
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="text-base">Mapa de flota</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col md:flex-row flex-1 overflow-hidden min-h-0">
          <div className="flex-1 relative min-h-[240px]">
            {open && (
              <MapContainer style={{ width: '100%', height: '100%' }} center={[0, 0]} zoom={2} zoomControl>
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapController
                  vehicles={vehicles}
                  statuses={statuses}
                  flyToId={flyToId}
                  onFlyComplete={() => setFlyToId(null)}
                />
                {vehicles.map((v, i) => {
                  const s = positionOf(statuses[v.id])
                  if (!s) return null
                  return (
                    <Marker key={v.id} position={[s.lat, s.lng]} icon={colorIcon(COLORS[i % COLORS.length])}>
                      <Popup>
                        <div style={{ minWidth: 140 }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>{v.name}</div>
                          {v.plate && <div style={{ color: '#64748b', fontSize: 12 }}>{v.plate}</div>}
                          <div style={{ marginTop: 6, fontSize: 12 }}>
                            Motor:{' '}
                            <span style={{ color: s.engineOn ? '#22c55e' : '#64748b', fontWeight: 500 }}>
                              {s.engineOn ? 'Encendido' : 'Apagado'}
                            </span>
                          </div>
                          {s.positionFresh && s.speedKmh > 0 && (
                            <div style={{ fontSize: 12, color: '#64748b' }}>{Math.round(s.speedKmh)} km/h</div>
                          )}
                          {s.positionTime && (
                            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                              GPS: {s.positionTime}
                            </div>
                          )}
                        </div>
                      </Popup>
                    </Marker>
                  )
                })}
              </MapContainer>
            )}
          </div>

          <div className="md:w-72 max-h-48 md:max-h-none shrink-0 border-t md:border-t-0 md:border-l flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b text-sm font-medium text-muted-foreground shrink-0">
              Flota ({vehicles.length} vehículo{vehicles.length !== 1 ? 's' : ''})
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {vehicles.map((v, i) => {
                const s = positionOf(statuses[v.id])
                return (
                  <div
                    key={v.id}
                    onClick={() => s && setFlyToId(v.id)}
                    className={`rounded-lg border p-3 text-sm transition-colors ${
                      s ? 'cursor-pointer hover:bg-muted/50' : 'opacity-60 cursor-default'
                    }`}
                    style={{ borderLeft: `4px solid ${COLORS[i % COLORS.length]}` }}
                  >
                    <div className="font-medium">{v.name}</div>
                    {v.plate && <div className="text-xs text-muted-foreground">{v.plate}</div>}
                    <div className="flex items-center gap-1.5 mt-1">
                      {s ? (
                        <>
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: s.engineOn ? '#22c55e' : '#94a3b8' }}
                          />
                          <span className="text-xs text-muted-foreground">
                            {s.engineOn ? 'Motor encendido' : 'Motor apagado'}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
                          {v.gps_device_id ? 'Sin señal GPS' : 'Sin GPS'}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
