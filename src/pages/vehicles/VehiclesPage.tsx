import { useState, useEffect, useCallback } from 'react'
import { Plus, RefreshCw, Truck, Map } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { getLiveStatuses, syncMileage } from '@/lib/gps'
import { dateInTz } from '@/lib/format'
import type { LiveStatus, Vehicle } from '@/types'
import { Button } from '@/components/ui/button'
import VehicleCard from './VehicleCard'
import VehicleModal from './VehicleModal'
import FleetMapModal from './FleetMapModal'

const POLL_MS = 60_000

interface Fleet {
  vehicles: Vehicle[]
  // null si no se pudo consultar el GPS: se conservan los estados anteriores.
  statuses: Record<string, LiveStatus> | null
}

// La RLS decide qué se ve: el admin ve toda la flota y el conductor solo su vehículo.
async function loadFleet(): Promise<Fleet> {
  const { data } = await supabase
    .from('vehicles')
    .select('*, driver:profiles(full_name)')
    .eq('active', true)
    .order('name')
  const vehicles = (data ?? []) as Vehicle[]
  if (!vehicles.some(v => v.gps_device_id)) return { vehicles, statuses: {} }
  const statuses = await getLiveStatuses().catch(() => null)
  return { vehicles, statuses }
}

export default function VehiclesPage() {
  const { isAdmin } = useAuth()
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [statuses, setStatuses] = useState<Record<string, LiveStatus>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editVehicle, setEditVehicle] = useState<Vehicle | null>(null)
  const [mapOpen, setMapOpen] = useState(false)

  const applyFleet = useCallback((fleet: Fleet) => {
    setVehicles(fleet.vehicles)
    if (fleet.statuses) setStatuses(fleet.statuses)
  }, [])

  // Recarga completa: además recalcula odómetros y gráficas (refreshKey).
  const reload = useCallback(async () => {
    applyFleet(await loadFleet())
    setRefreshKey(k => k + 1)
  }, [applyFleet])

  async function refresh() {
    setRefreshing(true)
    // El admin fuerza la sincronización de los km de hoy antes de recargar.
    if (isAdmin) await syncMileage(dateInTz()).catch(() => { /* no bloquea la recarga */ })
    await reload()
    setRefreshing(false)
  }

  useEffect(() => {
    let cancelled = false
    loadFleet().then(fleet => {
      if (cancelled) return
      applyFleet(fleet)
      setLoading(false)
    })
    // Actualiza posición y estado en vivo cada minuto.
    const interval = setInterval(() => {
      loadFleet().then(fleet => { if (!cancelled) applyFleet(fleet) })
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [applyFleet])

  function openNew() {
    setEditVehicle(null)
    setModalOpen(true)
  }

  function openEdit(v: Vehicle) {
    setEditVehicle(v)
    setModalOpen(true)
  }

  const title = isAdmin ? 'Vehículos' : vehicles.length === 1 ? 'Mi vehículo' : 'Mis vehículos'

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Truck size={22} />
            {title}
          </h1>
          {isAdmin && (
            <p className="text-sm text-muted-foreground">
              {vehicles.length} vehículo{vehicles.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} title="Actualizar" aria-label="Actualizar">
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMapOpen(true)}
            disabled={!vehicles.some(v => v.gps_device_id)}
            className="gap-1"
          >
            <Map size={15} />
            Mapa
          </Button>
          {isAdmin && (
            <Button size="sm" onClick={openNew} className="gap-1">
              <Plus size={15} />
              Agregar
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="rounded-2xl bg-gray-100 animate-pulse" style={{ aspectRatio: '2/3' }} />
          ))}
        </div>
      ) : vehicles.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Truck size={40} className="mx-auto mb-3 opacity-30" />
          {isAdmin ? (
            <>
              <p className="font-medium">Sin vehículos registrados</p>
              <p className="text-sm mt-1">Agrega el primer vehículo para comenzar</p>
              <Button className="mt-4" onClick={openNew}>
                <Plus size={15} className="mr-1" />
                Agregar vehículo
              </Button>
            </>
          ) : (
            <>
              <p className="font-medium">No tienes un vehículo asignado</p>
              <p className="text-sm mt-1">Pídele al administrador que te asigne uno.</p>
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
          {vehicles.map(v => (
            <VehicleCard
              key={v.id}
              vehicle={v}
              status={statuses[v.id]}
              refreshKey={refreshKey}
              onEdit={isAdmin ? () => openEdit(v) : undefined}
              onChanged={reload}
              canManage={isAdmin}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <VehicleModal vehicle={editVehicle} open={modalOpen} onClose={() => setModalOpen(false)} onSaved={reload} />
      )}
      <FleetMapModal open={mapOpen} onClose={() => setMapOpen(false)} vehicles={vehicles} statuses={statuses} />
    </div>
  )
}
