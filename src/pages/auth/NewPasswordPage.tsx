import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import PageLoader from '@/components/PageLoader'
import AuthShell from './AuthShell'

const MIN_LENGTH = 8

// Sirve para dos casos: el enlace de recuperación que llega por correo (Supabase
// abre una sesión temporal al cargar la página) y el cambio de contraseña de un
// usuario que ya inició sesión.
export default function NewPasswordPage() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  if (loading) return <PageLoader />

  if (!user) {
    return (
      <AuthShell>
        <div className="text-center py-2 space-y-3">
          <p className="font-medium">El enlace no es válido o ya expiró</p>
          <p className="text-sm text-muted-foreground">Solicita uno nuevo desde la pantalla de inicio de sesión.</p>
          <Button asChild variant="link"><Link to="/login">Ir al inicio de sesión</Link></Button>
        </div>
      </AuthShell>
    )
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_LENGTH} caracteres.`)
      return
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.')
      return
    }
    setSaving(true)
    const { error: err } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (err) setError(err.message)
    else navigate('/vehiculos', { replace: true })
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm font-medium">Define tu nueva contraseña</p>
        <div className="space-y-1">
          <Label htmlFor="password">Nueva contraseña</Label>
          <Input id="password" type="password" autoComplete="new-password" required
            value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="confirm">Repite la contraseña</Label>
          <Input id="confirm" type="password" autoComplete="new-password" required
            value={confirm} onChange={e => setConfirm(e.target.value)} />
        </div>
        {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <Button type="submit" disabled={saving} className="w-full">
          {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</> : 'Guardar contraseña'}
        </Button>
        <Button asChild type="button" variant="ghost" className="w-full text-sm text-muted-foreground">
          <Link to="/vehiculos">Cancelar</Link>
        </Button>
      </form>
    </AuthShell>
  )
}
