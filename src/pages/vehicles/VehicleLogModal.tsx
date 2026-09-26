import { useState, useEffect } from 'react'
import { Wrench, Hammer, Package, Fuel, FileText, Plus, Gauge } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { dateInTz, formatDate, formatKm, formatMoney } from '@/lib/format'
import type { VehicleLogType } from '@/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const LOG_TYPES: { value: VehicleLogType; label: string; icon: typeof Wrench; color: string }[] = [
  { value: 'maintenance', label: 'Mantenimiento', icon: Wrench, color: 'bg-blue-100 text-blue-700' },
  { value: 'repair', label: 'Reparación', icon: Hammer, color: 'bg-red-100 text-red-700' },
  { value: 'part', label: 'Repuesto', icon: Package, color: 'bg-purple-100 text-purple-700' },
  { value: 'fuel', label: 'Combustible', icon: Fuel, color: 'bg-yellow-100 text-yellow-700' },
  { value: 'note', label: 'Nota', icon: FileText, color: 'bg-gray-100 text-gray-700' },
]

interface LogEntry {
  id: string
  type: VehicleLogType
  description: string
  cost: number | null
  odometer_km: number | null
  date: string
  created_at: string
  author: { full_name: string } | null
}

interface Props {
  vehicleId: string
  vehicleName: string
  currentOdometer?: number
  open: boolean
  onClose: () => void
  onAdded?: () => void
}

const SELECT = '*, author:profiles(full_name)'

export default function VehicleLogModal({ vehicleId, vehicleName, currentOdometer, open, onClose, onAdded }: Props) {
  const { user } = useAuth()
  // Entradas junto con el vehículo al que pertenecen: mientras no coincidan con
  // el vehículo actual se muestra "Cargando...".
  const [log, setLog] = useState<{ vehicleId: string; entries: LogEntry[] } | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [type, setType] = useState<VehicleLogType>('maintenance')
  const [description, setDescription] = useState('')
  const [cost, setCost] = useState('')
  const [odometerKm, setOdometerKm] = useState('')
  const [date, setDate] = useState(dateInTz())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    supabase
      .from('vehicle_log')
      .select(SELECT)
      .eq('vehicle_id', vehicleId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!cancelled) setLog({ vehicleId, entries: (data ?? []) as LogEntry[] })
      })
    return () => { cancelled = true }
  }, [open, vehicleId])

  const loading = log?.vehicleId !== vehicleId
  const entries = loading ? [] : log.entries

  function openForm() {
    setOdometerKm(currentOdometer && currentOdometer > 0 ? String(Math.round(currentOdometer)) : '')
    setDate(dateInTz())
    setError('')
    setShowForm(true)
  }

  async function handleAdd() {
    if (!description.trim() || !user) return
    setSaving(true)
    setError('')
    const { data, error: err } = await supabase
      .from('vehicle_log')
      .insert({
        vehicle_id: vehicleId,
        type,
        description: description.trim(),
        cost: cost ? parseFloat(cost) : null,
        odometer_km: odometerKm ? parseFloat(odometerKm) : null,
        date,
        created_by: user.id,
      })
      .select(SELECT)
      .single()

    setSaving(false)
    if (err || !data) {
      setError(err?.message ?? 'No se pudo guardar la entrada.')
      return
    }
    setLog(prev => ({ vehicleId, entries: [data as LogEntry, ...(prev?.vehicleId === vehicleId ? prev.entries : [])] }))
    setDescription('')
    setCost('')
    setOdometerKm('')
    setType('maintenance')
    setShowForm(false)
    onAdded?.()
  }

  function typeInfo(t: string) {
    return LOG_TYPES.find(x => x.value === t) ?? LOG_TYPES[4]
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Bitácora — {vehicleName}</DialogTitle>
        </DialogHeader>

        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={openForm}>
            <Plus size={15} className="mr-1" />
            Nueva entrada
          </Button>
        </div>

        {showForm && (
          <div className="border rounded-lg p-3 space-y-3 bg-gray-50">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Tipo</Label>
                <Select value={type} onValueChange={v => setType(v as VehicleLogType)}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Fecha</Label>
                <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-8 text-sm" />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Descripción *</Label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Detalle del evento..."
                className="text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Kilometraje (km)</Label>
                <Input
                  type="number"
                  value={odometerKm}
                  onChange={e => setOdometerKm(e.target.value)}
                  placeholder={currentOdometer ? String(Math.round(currentOdometer)) : '0'}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Costo</Label>
                <Input
                  type="number"
                  value={cost}
                  onChange={e => setCost(e.target.value)}
                  placeholder="0"
                  className="h-8 text-sm"
                />
              </div>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>Cancelar</Button>
              <Button size="sm" onClick={handleAdd} disabled={saving || !description.trim()}>
                {saving ? 'Guardando...' : 'Agregar'}
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
          {loading && <p className="text-sm text-muted-foreground text-center py-4">Cargando...</p>}
          {!loading && entries.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">Sin entradas en la bitácora</p>
          )}
          {entries.map(e => {
            const t = typeInfo(e.type)
            const Icon = t.icon
            return (
              <div key={e.id} className="border rounded-lg p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${t.color}`}>
                    <Icon size={11} />
                    {t.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDate(e.date)}</span>
                </div>
                <p className="text-sm">{e.description}</p>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex items-center gap-3">
                    <span>{e.author?.full_name ?? '—'}</span>
                    {e.odometer_km != null && (
                      <span className="flex items-center gap-1">
                        <Gauge size={11} />
                        {formatKm(Number(e.odometer_km))}
                      </span>
                    )}
                  </div>
                  {e.cost != null && (
                    <span className="font-medium text-foreground">{formatMoney(Number(e.cost))}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
