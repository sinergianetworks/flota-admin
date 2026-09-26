import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// Los buckets son privados: en la base se guarda la ruta del archivo y para
// mostrarlo se genera una URL firmada de corta duración.
export const PHOTOS_BUCKET = 'vehicle-photos'
export const DOCS_BUCKET = 'vehicle-docs'

const SIGNED_URL_TTL = 60 * 60 // 1 h

export async function getSignedUrl(bucket: string, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL)
  if (error) return null
  return data.signedUrl
}

export function useSignedUrl(bucket: string, path: string | null | undefined): string | null {
  const [signed, setSigned] = useState<{ path: string; url: string | null } | null>(null)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    getSignedUrl(bucket, path).then(url => {
      if (!cancelled) setSigned({ path, url })
    })
    return () => { cancelled = true }
  }, [bucket, path])

  return path && signed?.path === path ? signed.url : null
}

// Sube un archivo a <vehicleId>/<prefijo>-<timestamp>.<ext> y devuelve la ruta.
// La carpeta por vehículo es la que usan las políticas de Storage.
export async function uploadVehicleFile(bucket: string, vehicleId: string, prefix: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'bin'
  const path = `${vehicleId}/${prefix}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type || undefined })
  if (error) throw new Error(error.message)
  return path
}

export async function removeFile(bucket: string, path: string | null | undefined) {
  if (!path) return
  await supabase.storage.from(bucket).remove([path])
}

export async function openSignedFile(bucket: string, path: string) {
  // Se abre la pestaña antes del await para que el navegador no la bloquee.
  const win = window.open('', '_blank')
  const url = await getSignedUrl(bucket, path)
  if (url && win) win.location.href = url
  else win?.close()
}
