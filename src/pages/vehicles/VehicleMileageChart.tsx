import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { supabase } from '@/lib/supabase'
import { addDays, dateInTz, formatKm, shortDayLabel } from '@/lib/format'

interface Props {
  vehicleId: string
  vehicleName: string
}

interface DayKm {
  date: string
  label: string
  km: number
}

const DAYS = 30

export default function VehicleMileageChart({ vehicleId, vehicleName }: Props) {
  const [data, setData] = useState<DayKm[] | null>(null)

  useEffect(() => {
    // "Hoy" según la zona horaria de la instalación, igual que la sincronización.
    const today = dateInTz()
    const from = addDays(today, -(DAYS - 1))

    supabase
      .from('vehicle_daily_mileage')
      .select('date, km')
      .eq('vehicle_id', vehicleId)
      .gte('date', from)
      .order('date')
      .then(({ data: rows }) => {
        const map: Record<string, number> = {}
        for (const r of rows ?? []) map[r.date] = Number(r.km)

        const result: DayKm[] = []
        for (let i = DAYS - 1; i >= 0; i--) {
          const date = addDays(today, -i)
          result.push({ date, label: shortDayLabel(date), km: map[date] ?? 0 })
        }
        setData(result)
      })
  }, [vehicleId])

  if (!data) return <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">Cargando...</div>

  const maxKm = Math.max(...data.map(d => d.km), 1)
  const totalKm = data.reduce((s, d) => s + d.km, 0)
  const daysWithData = data.filter(d => d.km > 0).length

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">Últimos {DAYS} días</span>
        <span className="text-muted-foreground">
          {formatKm(totalKm)}
          {daysWithData > 0 && ` · prom. ${formatKm(totalKm / daysWithData)}/día`}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={data} margin={{ top: 2, right: 0, left: -30, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9 }} interval={6} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
          <Tooltip
            formatter={(v) => [formatKm(Number(v), 1), vehicleName]}
            labelFormatter={(l) => l}
            contentStyle={{ fontSize: 11 }}
          />
          <Bar dataKey="km" radius={[2, 2, 0, 0]}>
            {data.map((entry) => (
              <Cell key={entry.date} fill={entry.km > maxKm * 0.7 ? '#3b82f6' : entry.km > 0 ? '#93c5fd' : '#e5e7eb'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
