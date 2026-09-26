import { useState, useEffect } from 'react'
import { Truck, Upload, Shield, FileText, Satellite } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { compressImage } from '@/lib/compressImage'
import { listGpsDevices, listGpsProviders } from '@/lib/gps'
import {
  DOCS_BUCKET, PHOTOS_BUCKET, openSignedFile, removeFile, uploadVehicleFile, useSignedUrl,
} from '@/lib/storage'
import type { GpsDevice, GpsProviderInfo, Vehicle } from '@/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface Driver {
  id: string
  full_name: string
}

interface Props {
  vehicle: Vehicle | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}

const NONE = 'none'

export default function VehicleModal({ vehicle, open, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [plate, setPlate] = useState('')
  const [chassisNumber, setChassisNumber] = useState('')
  const [gpsProvider, setGpsProvider] = useState(NONE)
  const [gpsDeviceId, setGpsDeviceId] = useState('')
  const [driverId, setDriverId] = useState(NONE)
  const [odometerOffset, setOdometerOffset] = useState('0')
  const [nextKm, setNextKm] = useState('')
  const [nextDate, setNextDate] = useState('')
  const [notes, setNotes] = useState('')
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [insuranceCompany, setInsuranceCompany] = useState('')
  const [insurancePolicy, setInsurancePolicy] = useState('')
  const [insuranceExpiry, setInsuranceExpiry] = useState('')
  const [insuranceDocFile, setInsuranceDocFile] = useState<File | null>(null)

  const [drivers, setDrivers] = useState<Driver[]>([])
  const [providers, setProviders] = useState<GpsProviderInfo[]>([])
  const [devices, setDevices] = useState<GpsDevice[]>([])
  const [devicesState, setDevicesState] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [devicesError, setDevicesError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const storedPhotoUrl = useSignedUrl(PHOTOS_BUCKET, open ? vehicle?.photo_url : null)
  const photoUrl = photoPreview ?? storedPhotoUrl

  useEffect(() => {
    if (!open) return
    supabase.from('profiles').select('id, full_name').eq('role', 'driver').eq('active', true).order('full_name')
      .then(({ data }) => setDrivers(data ?? []))
    listGpsProviders().then(setProviders).catch(() => setProviders([]))
  }, [open])

  useEffect(() => {
    if (!open) return
    setName(vehicle?.name ?? '')
    setPlate(vehicle?.plate ?? '')
    setChassisNumber(vehicle?.chassis_number ?? '')
    setGpsProvider(vehicle?.gps_provider ?? NONE)
    setGpsDeviceId(vehicle?.gps_device_id ?? '')
    setDriverId(vehicle?.assigned_driver_id ?? NONE)
    setOdometerOffset(String(vehicle?.odometer_offset ?? 0))
    setNextKm(vehicle?.next_maintenance_km != null ? String(vehicle.next_maintenance_km) : '')
    setNextDate(vehicle?.next_maintenance_date ?? '')
    setNotes(vehicle?.notes ?? '')
    setInsuranceCompany(vehicle?.insurance_company ?? '')
    setInsurancePolicy(vehicle?.insurance_policy ?? '')
    setInsuranceExpiry(vehicle?.insurance_expiry ?? '')
    setPhotoFile(null)
    setPhotoPreview(null)
    setInsuranceDocFile(null)
    setError('')
  }, [vehicle, open])

  // Lista de dispositivos del proveedor elegido. Si el proveedor no la ofrece o
  // falla, se puede escribir el ID del dispositivo a mano.
  useEffect(() => {
    if (!open || gpsProvider === NONE) {
      setDevices([])
      setDevicesState('idle')
      return
    }
    let cancelled = false
    setDevicesState('loading')
    setDevicesError('')
    listGpsDevices(gpsProvider)
      .then(list => {
        if (cancelled) return
        setDevices(list)
        setDevicesState('ready')
      })
      .catch(e => {
        if (cancelled) return
        setDevices([])
        setDevicesError(e instanceof Error ? e.message : String(e))
        setDevicesState('error')
      })
    return () => { cancelled = true }
  }, [open, gpsProvider])

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const compressed = await compressImage(file, 800)
    setPhotoFile(compressed)
    setPhotoPreview(URL.createObjectURL(compressed))
  }

  function handleInsuranceDocChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) setInsuranceDocFile(file)
  }

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    setError('')
    try {
      const hasGps = gpsProvider !== NONE && gpsDeviceId.trim() !== ''
      const payload = {
        name: name.trim(),
        plate: plate.trim() || null,
        chassis_number: chassisNumber.trim() || null,
        gps_provider: hasGps ? gpsProvider : null,
        gps_device_id: hasGps ? gpsDeviceId.trim() : null,
        odometer_offset: parseFloat(odometerOffset) || 0,
        assigned_driver_id: driverId !== NONE ? driverId : null,
        next_maintenance_km: nextKm ? parseFloat(nextKm) : null,
        next_maintenance_date: nextDate || null,
        notes: notes.trim() || null,
        insurance_company: insuranceCompany.trim() || null,
        insurance_policy: insurancePolicy.trim() || null,
        insurance_expiry: insuranceExpiry || null,
      }

      // Los archivos se guardan en <vehicle_id>/..., así que un vehículo nuevo
      // se crea primero y los archivos se suben después.
      let vehicleId = vehicle?.id
      if (vehicle) {
        const { error: err } = await supabase.from('vehicles').update(payload).eq('id', vehicle.id)
        if (err) throw new Error(err.message)
      } else {
        const { data, error: err } = await supabase.from('vehicles').insert(payload).select('id').single()
        if (err || !data) throw new Error(err?.message ?? 'No se pudo crear el vehículo.')
        vehicleId = data.id
      }

      const files: { photo_url?: string; insurance_doc_url?: string } = {}
      if (photoFile) files.photo_url = await uploadVehicleFile(PHOTOS_BUCKET, vehicleId!, 'foto', photoFile)
      if (insuranceDocFile) files.insurance_doc_url = await uploadVehicleFile(DOCS_BUCKET, vehicleId!, 'seguro', insuranceDocFile)

      if (Object.keys(files).length > 0) {
        const { error: err } = await supabase.from('vehicles').update(files).eq('id', vehicleId!)
        if (err) throw new Error(err.message)
        // Se borran los archivos reemplazados para no dejar huérfanos.
        if (files.photo_url) await removeFile(PHOTOS_BUCKET, vehicle?.photo_url)
        if (files.insurance_doc_url) await removeFile(DOCS_BUCKET, vehicle?.insurance_doc_url)
      }

      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const deviceInList = devices.some(d => d.id === gpsDeviceId)

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{vehicle ? 'Editar vehículo' : 'Agregar vehículo'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 rounded-lg border bg-gray-100 flex items-center justify-center overflow-hidden shrink-0">
              {photoUrl ? (
                <img src={photoUrl} alt="Foto del vehículo" className="w-full h-full object-cover" />
              ) : (
                <Truck size={32} className="text-gray-400" />
              )}
            </div>
            <Label className="cursor-pointer flex items-center gap-2 text-sm text-primary">
              <Upload size={16} />
              {photoUrl ? 'Cambiar foto' : 'Subir foto'}
              <input type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
            </Label>
          </div>

          <div className="space-y-1">
            <Label>Nombre *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Camioneta de reparto" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Número de placa</Label>
              <Input value={plate} onChange={e => setPlate(e.target.value)} placeholder="ABC-1234" />
            </div>
            <div className="space-y-1">
              <Label>Número de chasis</Label>
              <Input value={chassisNumber} onChange={e => setChassisNumber(e.target.value)} placeholder="VIN / chasis" />
            </div>
          </div>

          <div className="space-y-3 border rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Satellite size={15} className="text-primary" />
              Rastreo GPS
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Proveedor</Label>
              <Select value={gpsProvider} onValueChange={v => { setGpsProvider(v); setGpsDeviceId('') }}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin GPS (km manuales)</SelectItem>
                  {providers.map(p => (
                    <SelectItem key={p.id} value={p.id} disabled={!p.configured}>
                      {p.name}{p.configured ? '' : ' (sin configurar)'}
                    </SelectItem>
                  ))}
                  {/* Proveedor guardado que ya no está disponible en el servidor */}
                  {gpsProvider !== NONE && !providers.some(p => p.id === gpsProvider) && (
                    <SelectItem value={gpsProvider}>{gpsProvider}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {gpsProvider !== NONE && (
              <div className="space-y-1">
                <Label className="text-xs">Dispositivo</Label>
                {devicesState === 'ready' && devices.length > 0 ? (
                  <Select value={gpsDeviceId || undefined} onValueChange={setGpsDeviceId}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Selecciona un dispositivo" />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.map(d => (
                        <SelectItem key={d.id} value={d.id}>{d.name} — {d.id}</SelectItem>
                      ))}
                      {gpsDeviceId && !deviceInList && (
                        <SelectItem value={gpsDeviceId}>{gpsDeviceId} (no encontrado en la cuenta)</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={gpsDeviceId}
                    onChange={e => setGpsDeviceId(e.target.value)}
                    placeholder={devicesState === 'loading' ? 'Cargando dispositivos...' : 'ID del dispositivo (IMEI)'}
                    className="h-8 text-sm"
                    disabled={devicesState === 'loading'}
                  />
                )}
                {devicesState === 'error' && (
                  <p className="text-xs text-red-500">No se pudo cargar la lista: {devicesError}. Puedes escribir el ID a mano.</p>
                )}
                {devicesState === 'ready' && devices.length === 0 && (
                  <p className="text-xs text-muted-foreground">No se encontraron dispositivos en la cuenta del proveedor.</p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label>Conductor asignado</Label>
            <Select value={driverId} onValueChange={setDriverId}>
              <SelectTrigger>
                <SelectValue placeholder="Sin asignar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin asignar</SelectItem>
                {drivers.map(d => (
                  <SelectItem key={d.id} value={d.id}>{d.full_name}</SelectItem>
                ))}
                {driverId !== NONE && !drivers.some(d => d.id === driverId) && (
                  <SelectItem value={driverId}>{vehicle?.driver?.full_name ?? 'Usuario inactivo'}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>Odómetro base (km)</Label>
            <Input
              type="number"
              value={odometerOffset}
              onChange={e => setOdometerOffset(e.target.value)}
              placeholder="Ej: 125000"
            />
            <p className="text-xs text-muted-foreground">
              {gpsProvider !== NONE
                ? 'Kilometraje real al instalar el GPS. Los km diarios del GPS se suman a este valor.'
                : 'Kilometraje de referencia. Sin GPS, se muestra la última lectura de la bitácora si es mayor.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Próx. mantenimiento (km)</Label>
              <Input type="number" value={nextKm} onChange={e => setNextKm(e.target.value)} placeholder="Ej: 150000" />
            </div>
            <div className="space-y-1">
              <Label>Próx. mantenimiento (fecha)</Label>
              <Input type="date" value={nextDate} onChange={e => setNextDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-3 border rounded-lg p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Shield size={15} className="text-primary" />
              Seguro
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Aseguradora</Label>
                <Input value={insuranceCompany} onChange={e => setInsuranceCompany(e.target.value)} className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">N.º de póliza</Label>
                <Input value={insurancePolicy} onChange={e => setInsurancePolicy(e.target.value)} className="h-8 text-sm" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Vencimiento</Label>
              <Input type="date" value={insuranceExpiry} onChange={e => setInsuranceExpiry(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Documento (PDF o imagen)</Label>
              <div className="flex items-center gap-2 flex-wrap">
                <Label className="cursor-pointer flex items-center gap-2 text-xs text-primary border rounded-md px-3 py-1.5 hover:bg-gray-50">
                  <Upload size={13} />
                  {insuranceDocFile?.name || (vehicle?.insurance_doc_url ? 'Reemplazar documento' : 'Subir documento')}
                  <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleInsuranceDocChange} />
                </Label>
                {vehicle?.insurance_doc_url && !insuranceDocFile && (
                  <button
                    type="button"
                    onClick={() => openSignedFile(DOCS_BUCKET, vehicle.insurance_doc_url!)}
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <FileText size={12} />
                    Ver actual
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Notas</Label>
            <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observaciones..." />
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Guardando...' : 'Guardar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
