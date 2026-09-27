import { useState, useEffect, useRef } from 'react'
import {
  Truck, MapPin, BookOpen, Pencil, Gauge, AlertCircle, Wrench, BarChart2, ExternalLink, X, Shield, FileText, Archive, RotateCcw,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { DOCS_BUCKET, PHOTOS_BUCKET, openSignedFile, useSignedUrl } from '@/lib/storage'
import { dateInTz, formatDate, formatKm, getInitials } from '@/lib/format'
import type { LiveStatus, Vehicle } from '@/types'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import VehicleLogModal from './VehicleLogModal'
import VehicleMileageChart from './VehicleMileageChart'
import { useOdometer } from './useOdometer'
import { useFleetSettings } from '@/lib/settings'

interface Props {
  vehicle: Vehicle
  status: LiveStatus | undefined
  refreshKey: number
  onEdit?: () => void
  onChanged: () => void
  canManage: boolean
  // Vista de archivados: sin GPS en vivo ni recorrido; permite restaurar.
  archived?: boolean
  onRestore?: () => Promise<void>
}

function MovementBadge({ vehicle, status }: { vehicle: Vehicle; status: LiveStatus | undefined }) {
  const base = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold border backdrop-blur-sm shadow-sm bg-white/90'

  if (!vehicle.gps_device_id) {
    return (
      <span className={`${base} text-gray-500 border-gray-200`}>
        Sin GPS
      </span>
    )
  }
  if (!status || !status.online) {
    return (
      <span className={`${base} text-gray-500 border-gray-200`}>
        <span className="w-2 h-2 rounded-full bg-gray-400 inline-block" />
        Sin señal
      </span>
    )
  }
  if (!status.engineOn) {
    return (
      <span className={`${base} text-slate-600 border-slate-200`}>
        <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />
        Motor apagado
      </span>
    )
  }
  if (status.speedKmh > 3 && status.positionFresh) {
    return (
      <span className={`${base} text-green-700 border-green-200`}>
        <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
        En marcha
      </span>
    )
  }
  return (
    <span className={`${base} text-yellow-700 border-yellow-200`}>
      <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />
      Ralentí
    </span>
  )
}

// Intervalo asumido para la barra de progreso: 10.000 km
const SERVICE_INTERVAL_KM = 10_000

function MaintenanceBar({ vehicle, odometer, hasData, thresholdKm }: { vehicle: Vehicle; odometer: number; hasData: boolean; thresholdKm: number }) {
  if (vehicle.next_maintenance_km == null || !hasData) return null

  const remaining = Number(vehicle.next_maintenance_km) - odometer
  const overdue = remaining <= 0
  const pct = overdue ? 0 : Math.min(100, (remaining / SERVICE_INTERVAL_KM) * 100)
  // Rojo en el último tercio del umbral (con 2.000 km: desde 667 km).
  const urgentKm = Math.ceil(thresholdKm / 3)

  const tone = overdue || remaining <= urgentKm
    ? { bar: 'bg-red-500', text: 'text-red-600', note: 'Mantenimiento urgente', Icon: AlertCircle as React.ElementType | null }
    : remaining <= thresholdKm
      ? { bar: 'bg-amber-400', text: 'text-amber-600', note: 'Próximo pronto', Icon: Wrench as React.ElementType | null }
      : { bar: 'bg-green-500', text: 'text-green-700', note: 'Al día', Icon: null }

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground font-[500]">
          <Wrench size={13} className="text-gray-400" />
          Próx. mantenimiento
        </div>
        <span className={`text-[14px] font-[730] tabular-nums ${tone.text}`}>
          {overdue ? `Vencido ${formatKm(Math.abs(remaining))}` : formatKm(remaining)}
        </span>
      </div>
      <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${tone.bar}`} style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      {tone.Icon && (
        <div className={`flex items-center gap-1.5 text-[12px] font-[600] ${tone.text}`}>
          <tone.Icon size={12} />
          {tone.note}
        </div>
      )}
    </div>
  )
}

function daysUntil(dateStr: string): number {
  // Diferencia de calendario entre hoy (zona de la instalación) y la fecha dada.
  const today = Date.parse(`${dateInTz()}T00:00:00Z`)
  const target = Date.parse(`${dateStr}T00:00:00Z`)
  return Math.round((target - today) / 86_400_000)
}

function MaintenanceDateRow({ vehicle, thresholdDays }: { vehicle: Vehicle; thresholdDays: number }) {
  if (!vehicle.next_maintenance_date) return null
  const daysLeft = daysUntil(vehicle.next_maintenance_date)
  if (daysLeft > thresholdDays) return null

  const tone = daysLeft < 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'
  const text = daysLeft < 0
    ? `Mantenimiento vencido hace ${-daysLeft} día${daysLeft === -1 ? '' : 's'}`
    : daysLeft === 0
      ? 'Mantenimiento programado para hoy'
      : `Mantenimiento en ${daysLeft} día${daysLeft === 1 ? '' : 's'}`

  return (
    <div className={`flex items-start gap-1.5 text-xs rounded px-2 py-1.5 ${tone}`}>
      <Wrench size={12} className="mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">{text}</p>
        <p>{formatDate(vehicle.next_maintenance_date)}</p>
      </div>
    </div>
  )
}

function InsuranceRow({ vehicle, thresholdDays }: { vehicle: Vehicle; thresholdDays: number }) {
  if (!vehicle.insurance_company && !vehicle.insurance_policy && !vehicle.insurance_expiry && !vehicle.insurance_doc_url) {
    return null
  }
  const daysLeft = vehicle.insurance_expiry ? daysUntil(vehicle.insurance_expiry) : null
  const tone = daysLeft == null || daysLeft > thresholdDays
    ? 'bg-gray-50 text-gray-600'
    : daysLeft <= 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'

  const expiryText = daysLeft == null
    ? null
    : daysLeft <= 0 ? 'Vencido'
      : daysLeft <= thresholdDays ? `Vence en ${daysLeft} día${daysLeft !== 1 ? 's' : ''}`
        : `Vence ${formatDate(vehicle.insurance_expiry)}`

  return (
    <div className={`flex items-start gap-1.5 text-xs rounded px-2 py-1.5 ${tone}`}>
      <Shield size={12} className="mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="truncate">
          {[vehicle.insurance_company, vehicle.insurance_policy && `Póliza ${vehicle.insurance_policy}`]
            .filter(Boolean).join(' · ') || 'Seguro'}
        </p>
        {expiryText && <p className="font-medium">{expiryText}</p>}
      </div>
      {vehicle.insurance_doc_url && (
        <button
          onClick={() => openSignedFile(DOCS_BUCKET, vehicle.insurance_doc_url!)}
          className="shrink-0 flex items-center gap-1 hover:underline"
          title="Ver documento del seguro"
        >
          <FileText size={12} />
          Ver
        </button>
      )}
    </div>
  )
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16`,
      { headers: { 'Accept-Language': 'es' } }
    )
    const data = await res.json()
    const a = data.address ?? {}
    const parts = [a.road, a.suburb ?? a.neighbourhood ?? a.city_district, a.city ?? a.town ?? a.village].filter(Boolean)
    return parts.slice(0, 2).join(', ') || data.display_name?.split(',').slice(0, 2).join(',') || ''
  } catch { return '' }
}

export default function VehicleCard({ vehicle, status, refreshKey, onEdit, onChanged, canManage, archived = false, onRestore }: Props) {
  const [restoring, setRestoring] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showChart, setShowChart] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [editingOffset, setEditingOffset] = useState(false)
  const [offsetInput, setOffsetInput] = useState('')
  const [savingOffset, setSavingOffset] = useState(false)
  const [location, setLocation] = useState<{ key: string; text: string } | null>(null)
  const [logVersion, setLogVersion] = useState(0)
  const geocodedKey = useRef('')

  const photoUrl = useSignedUrl(PHOTOS_BUCKET, vehicle.photo_url)
  const odometer = useOdometer(vehicle, refreshKey + logVersion)
  const settings = useFleetSettings()
  const hasGps = !!vehicle.gps_device_id

  const lat = status?.lat ?? null
  const lng = status?.lng ?? null
  const hasPosition = lat != null && lng != null && !(lat === 0 && lng === 0)
  const posKey = hasPosition ? `${lat!.toFixed(4)},${lng!.toFixed(4)}` : ''
  const locationText = location?.key === posKey ? location.text : ''

  useEffect(() => {
    if (!posKey || geocodedKey.current === posKey) return
    geocodedKey.current = posKey
    reverseGeocode(lat!, lng!).then(text => setLocation({ key: posKey, text }))
  }, [posKey, lat, lng])

  const osmUrl = hasPosition ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=16` : null
  const embedUrl = hasPosition
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${lng! - 0.01},${lat! - 0.01},${lng! + 0.01},${lat! + 0.01}&layer=mapnik&marker=${lat},${lng}`
    : null

  async function saveOffset() {
    setSavingOffset(true)
    await supabase.from('vehicles').update({ odometer_offset: parseFloat(offsetInput) || 0 }).eq('id', vehicle.id)
    setSavingOffset(false)
    setEditingOffset(false)
    onChanged()
  }

  return (
    <>
      <Card className={`overflow-hidden transition-shadow duration-200 hover:shadow-md ${archived ? 'opacity-75' : ''}`}>
        <div className="relative w-full bg-white overflow-hidden aspect-[3/2]">
          {photoUrl ? (
            <img src={photoUrl} alt={vehicle.name} className="w-full h-full object-contain p-3" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Truck size={48} className="text-gray-200" />
            </div>
          )}
          <div className="absolute top-2.5 right-2.5">
            {archived ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold border shadow-sm bg-white/90 text-gray-600 border-gray-300">
                <Archive size={12} />
                Archivado
              </span>
            ) : (
              <MovementBadge vehicle={vehicle} status={status} />
            )}
          </div>
        </div>

        <CardContent className="p-0">
          <div className="px-4 pt-3.5 pb-3 space-y-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-[730] text-[18px] leading-tight tracking-tight">{vehicle.name}</h3>
              {vehicle.plate && (
                <span className="shrink-0 text-[11.5px] font-[650] tracking-widest text-gray-500 bg-gray-100 border border-gray-200 rounded-[7px] px-2 py-0.5 font-mono">
                  {vehicle.plate}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Gauge size={14} className="text-muted-foreground shrink-0" />
              {editingOffset ? (
                <div className="flex items-center gap-1 flex-1">
                  <Input
                    type="number"
                    value={offsetInput}
                    onChange={e => setOffsetInput(e.target.value)}
                    className="h-6 text-xs px-1 w-24"
                    placeholder="Odómetro base"
                  />
                  <Button size="sm" className="h-6 text-xs px-2" onClick={saveOffset} disabled={savingOffset}>
                    {savingOffset ? '...' : 'OK'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-xs px-1" onClick={() => setEditingOffset(false)}>✕</Button>
                </div>
              ) : (
                <div className="flex items-center gap-1 flex-1">
                  <span className={odometer.hasData
                    ? 'text-[16px] font-[700] tabular-nums tracking-tight'
                    : 'text-sm font-[500] text-muted-foreground'}>
                    {odometer.hasData ? formatKm(odometer.km) : hasGps ? 'Sin datos' : '— km'}
                  </span>
                  {odometer.fromLog && (
                    <span className="text-[11px] text-muted-foreground">(bitácora)</span>
                  )}
                  {canManage && (
                    <button
                      onClick={() => { setOffsetInput(String(vehicle.odometer_offset ?? 0)); setEditingOffset(true) }}
                      className="text-muted-foreground hover:text-foreground ml-1"
                      title="Ajustar odómetro base"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                </div>
              )}
            </div>

            {vehicle.driver && (
              <div className="flex items-center gap-2">
                <Avatar className="h-6 w-6 shrink-0">
                  <AvatarFallback className="text-[10px] font-[700] bg-gray-100 text-gray-600">
                    {getInitials(vehicle.driver.full_name)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-[13.5px] font-[500] text-gray-700 truncate">{vehicle.driver.full_name}</span>
              </div>
            )}

            {hasPosition ? (
              <button onClick={() => setShowMap(true)} className="flex items-start gap-1.5 w-full text-left group" title="Ver en mapa">
                <MapPin size={12} className="text-blue-500 mt-0.5 shrink-0" />
                <span className="text-xs text-blue-600 group-hover:underline leading-tight line-clamp-2">
                  {locationText || `${lat!.toFixed(5)}, ${lng!.toFixed(5)}`}
                  {status!.engineOn && status!.speedKmh > 3 && status!.positionFresh && ` · ${Math.round(status!.speedKmh)} km/h`}
                </span>
              </button>
            ) : hasGps ? (
              <div className="flex items-center gap-1.5">
                <MapPin size={12} className="text-gray-300 shrink-0" />
                <span className="text-xs text-muted-foreground">Sin señal GPS</span>
              </div>
            ) : null}

            <MaintenanceBar vehicle={vehicle} odometer={odometer.km} hasData={odometer.hasData} thresholdKm={settings.maintenance_km_threshold} />
            <MaintenanceDateRow vehicle={vehicle} thresholdDays={settings.maintenance_days_threshold} />
            <InsuranceRow vehicle={vehicle} thresholdDays={settings.insurance_days_threshold} />
          </div>

          {showChart && (
            <div className="border-t border-gray-100 px-4 py-3 animate-in slide-in-from-top-1 duration-200">
              <VehicleMileageChart vehicleId={vehicle.id} vehicleName={vehicle.name} />
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-2.5 border-t border-gray-100">
            {archived && onRestore && (
              <button
                className="flex flex-1 items-center justify-center gap-1.5 h-[42px] rounded-[11px] text-[13.5px] font-[620] border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 hover:border-gray-300 transition-colors disabled:opacity-50"
                onClick={async () => {
                  setRestoring(true)
                  try { await onRestore() } finally { setRestoring(false) }
                }}
                disabled={restoring}
                title="Restaurar vehículo"
              >
                <RotateCcw size={14} />
                {restoring ? 'Restaurando...' : 'Restaurar'}
              </button>
            )}
            {!archived && (
            <>
            <button
              className={`flex flex-1 items-center justify-center gap-1.5 h-[42px] rounded-[11px] text-[13.5px] font-[620] border transition-colors
                ${!hasPosition ? 'border-gray-200 text-gray-300 cursor-not-allowed bg-white' : 'border-gray-200 text-gray-700 bg-white hover:bg-gray-50 hover:border-gray-300'}`}
              onClick={() => setShowMap(true)}
              disabled={!hasPosition}
              title={!hasPosition ? 'Sin ubicación disponible' : 'Ver en mapa'}
            >
              <MapPin size={14} />
              Mapa
            </button>
            {hasGps && (
              <button
                className={`flex flex-1 items-center justify-center gap-1.5 h-[42px] rounded-[11px] text-[13.5px] font-[620] border transition-colors
                  ${showChart
                    ? 'bg-primary border-primary text-primary-foreground hover:bg-primary/90'
                    : 'border-gray-200 text-gray-700 bg-white hover:bg-gray-50 hover:border-gray-300'}`}
                onClick={() => setShowChart(v => !v)}
                title="Ver distancia recorrida por día"
              >
                <BarChart2 size={14} />
                Recorrido
              </button>
            )}
            </>
            )}
            <button
              className="flex items-center justify-center w-[42px] h-[42px] rounded-[11px] border border-gray-200 text-gray-500 bg-white hover:bg-gray-50 hover:border-gray-300 transition-colors"
              onClick={() => setShowLog(true)}
              title="Bitácora"
            >
              <BookOpen size={14} />
            </button>
            {onEdit && (
              <button
                className="flex items-center justify-center w-[42px] h-[42px] rounded-[11px] border border-gray-200 text-gray-500 bg-white hover:bg-gray-50 hover:border-gray-300 transition-colors"
                onClick={onEdit}
                title="Editar vehículo"
              >
                <Pencil size={14} />
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      <VehicleLogModal
        vehicleId={vehicle.id}
        vehicleName={vehicle.name}
        currentOdometer={odometer.km}
        open={showLog}
        onClose={() => setShowLog(false)}
        onAdded={() => setLogVersion(v => v + 1)}
      />

      {showMap && embedUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-5 animate-in fade-in duration-200"
          onClick={() => setShowMap(false)}
        >
          <div
            className="relative bg-white rounded-[18px] overflow-hidden shadow-2xl w-full max-w-[560px] animate-in zoom-in-95 slide-in-from-bottom-2 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100">
              <MapPin size={18} className="text-blue-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-[700] text-[15px] leading-tight">{vehicle.name}</p>
                {locationText && <p className="text-[12px] text-muted-foreground mt-0.5 truncate">{locationText}</p>}
              </div>
              <button
                onClick={() => setShowMap(false)}
                className="w-9 h-9 flex items-center justify-center rounded-[9px] text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </div>
            <div className="relative" style={{ height: 280 }}>
              <iframe src={embedUrl} className="w-full h-full border-none" title={`Ubicación de ${vehicle.name}`} />
            </div>
            <div className="px-4 py-3.5">
              <p className="text-[12px] text-muted-foreground tabular-nums mb-3">
                {lat!.toFixed(5)}, {lng!.toFixed(5)}
              </p>
              <a
                href={osmUrl!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-center gap-2 h-[46px] bg-primary hover:bg-primary/90 text-primary-foreground rounded-[12px] text-[14.5px] font-[640] transition-colors"
              >
                <ExternalLink size={16} />
                Abrir en mapa
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
