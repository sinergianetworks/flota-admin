import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import AuthShell from './AuthShell'

export default function LoginPage() {
  const { signIn, resetPassword, user, profile } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [resetMode, setResetMode] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  if (user && profile) return <Navigate to="/vehiculos" replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    if (resetMode) {
      const err = await resetPassword(email)
      if (err) setError(err.message)
      else setResetSent(true)
    } else {
      const err = await signIn(email, password)
      if (err) {
        const msg = err.message.toLowerCase()
        if (msg.includes('email not confirmed')) {
          setError('Tu cuenta aún no fue confirmada. Contacta al administrador.')
        } else if (msg.includes('invalid login credentials') || msg.includes('invalid credentials')) {
          setError('Credenciales incorrectas. Verifica tu correo y contraseña.')
        } else {
          setError(err.message)
        }
      }
    }
    setLoading(false)
  }

  return (
    <AuthShell>
      {resetSent ? (
        <div className="text-center py-4">
          <p className="text-green-600 font-medium">Revisa tu correo</p>
          <p className="text-sm text-muted-foreground mt-1">
            Te enviamos un enlace para restablecer tu contraseña.
          </p>
          <Button variant="link" onClick={() => { setResetMode(false); setResetSent(false) }} className="mt-4 text-sm">
            Volver al inicio de sesión
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="email">Correo electrónico</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="nombre@empresa.com"
            />
          </div>

          {!resetMode && (
            <div className="space-y-1">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          )}

          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Procesando...
              </>
            ) : resetMode ? 'Enviar enlace' : 'Iniciar sesión'}
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={() => { setResetMode(!resetMode); setError('') }}
            className="w-full text-sm text-muted-foreground"
          >
            {resetMode ? 'Volver al inicio de sesión' : '¿Olvidaste tu contraseña?'}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
