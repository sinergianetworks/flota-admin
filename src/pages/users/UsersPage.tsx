import { useCallback, useEffect, useState } from 'react'
import { Plus, Users, Pencil, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { invokeFunction } from '@/lib/functions'
import { getInitials } from '@/lib/format'
import { useAuth } from '@/hooks/useAuth'
import { ROLE_LABELS, type Profile, type UserRole } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const MIN_PASSWORD = 8

export default function UsersPage() {
  const { profile: me } = useAuth()
  const [users, setUsers] = useState<Profile[] | null>(null)
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, active, created_at')
      .order('full_name')
      .then(({ data }) => {
        if (!cancelled) setUsers((data ?? []) as Profile[])
      })
    return () => { cancelled = true }
  }, [version])

  const load = useCallback(() => setVersion(v => v + 1), [])
  const loading = users === null

  async function toggleActive(u: Profile) {
    await supabase.from('profiles').update({ active: !u.active }).eq('id', u.id)
    load()
  }

  function openNew() { setEditing(null); setModalOpen(true) }
  function openEdit(u: Profile) { setEditing(u); setModalOpen(true) }

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Users size={22} />
            Usuarios
          </h1>
          <p className="text-sm text-muted-foreground">Administradores y conductores con acceso a la plataforma</p>
        </div>
        <Button size="sm" onClick={openNew} className="gap-1">
          <Plus size={15} />
          Nuevo usuario
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground text-center py-12">Cargando...</p>
      ) : (
        <Card className="divide-y">
          {(users ?? []).map(u => {
            const isMe = u.id === me?.id
            return (
              <div key={u.id} className={`flex items-center gap-3 px-4 py-3 ${u.active ? '' : 'opacity-60'}`}>
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarFallback className="text-xs">{getInitials(u.full_name)}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{u.full_name}</p>
                    <Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="text-[10px]">
                      {ROLE_LABELS[u.role]}
                    </Badge>
                    {!u.active && <Badge variant="outline" className="text-[10px]">Inactivo</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {u.email}{u.phone ? ` · ${u.phone}` : ''}
                  </p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => openEdit(u)} title="Editar">
                  <Pencil size={15} />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleActive(u)}
                  disabled={isMe}
                  title={isMe ? 'No puedes desactivar tu propio usuario' : undefined}
                >
                  {u.active ? 'Desactivar' : 'Activar'}
                </Button>
              </div>
            )
          })}
        </Card>
      )}

      <UserModal
        user={editing}
        isSelf={editing?.id === me?.id}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={load}
      />
    </div>
  )
}

interface ModalProps {
  user: Profile | null
  isSelf: boolean
  open: boolean
  onClose: () => void
  onSaved: () => void
}

function UserModal({ user, isSelf, open, onClose, onSaved }: ModalProps) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<UserRole>('driver')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setFullName(user?.full_name ?? '')
    setEmail(user?.email ?? '')
    setPhone(user?.phone ?? '')
    setRole(user?.role ?? 'driver')
    setPassword('')
    setError('')
  }, [user, open])

  async function handleSave() {
    setError('')
    if (!fullName.trim()) { setError('El nombre es obligatorio.'); return }
    setSaving(true)
    try {
      if (user) {
        const { error: err } = await supabase
          .from('profiles')
          .update({ full_name: fullName.trim(), phone: phone.trim() || null, role })
          .eq('id', user.id)
        if (err) throw new Error(err.message)
      } else {
        if (password.length < MIN_PASSWORD) {
          throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`)
        }
        await invokeFunction('create-user', {
          email: email.trim(),
          password,
          full_name: fullName.trim(),
          phone: phone.trim() || null,
          role,
        })
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{user ? 'Editar usuario' : 'Nuevo usuario'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Nombre completo *</Label>
            <Input value={fullName} onChange={e => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Correo electrónico {user ? '' : '*'}</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} disabled={!!user} />
            {user && <p className="text-xs text-muted-foreground">El correo no se puede cambiar desde aquí.</p>}
          </div>
          <div className="space-y-1">
            <Label>Teléfono</Label>
            <Input value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Rol</Label>
            <Select value={role} onValueChange={v => setRole(v as UserRole)} disabled={isSelf}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="driver">{ROLE_LABELS.driver}</SelectItem>
                <SelectItem value="admin">{ROLE_LABELS.admin}</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && <p className="text-xs text-muted-foreground">No puedes cambiar tu propio rol.</p>}
          </div>
          {!user && (
            <div className="space-y-1">
              <Label>Contraseña inicial *</Label>
              <Input type="text" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" />
              <p className="text-xs text-muted-foreground">
                Compártela con el usuario; podrá cambiarla desde el menú "Cambiar contraseña".
              </p>
            </div>
          )}
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</> : 'Guardar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
