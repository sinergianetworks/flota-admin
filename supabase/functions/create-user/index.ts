// create-user: el admin da de alta un usuario (conductor o admin).
//
// Crea la cuenta en Auth con el correo ya confirmado; el trigger
// handle_new_user crea el perfil como conductor y aquí se ajustan el rol,
// el nombre y el teléfono. Si algo falla después de crear la cuenta, se
// borra para no dejar usuarios a medias.
import { serve, json, readJson, HttpError } from '../_shared/http.ts'
import { adminClient, requireAdmin, type Role } from '../_shared/supabase.ts'

const ROLES: Role[] = ['admin', 'driver']
const MIN_PASSWORD = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Body {
  email?: string
  password?: string
  full_name?: string
  phone?: string | null
  role?: string
}

function translateAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('already') && (m.includes('registered') || m.includes('exists'))) {
    return 'Ya existe un usuario con ese correo.'
  }
  if (m.includes('password')) return `La contraseña no es válida (mínimo ${MIN_PASSWORD} caracteres).`
  if (m.includes('email')) return 'El correo no es válido.'
  return message
}

serve(async (req) => {
  const admin = adminClient()
  await requireAdmin(req, admin)

  const body = await readJson<Body>(req)
  const email = (body.email ?? '').trim().toLowerCase()
  const password = body.password ?? ''
  const fullName = (body.full_name ?? '').trim()
  const phone = (body.phone ?? '').toString().trim() || null
  const role = (body.role ?? 'driver') as Role

  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'El correo no es válido.')
  if (password.length < MIN_PASSWORD) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`)
  }
  if (!fullName) throw new HttpError(400, 'El nombre es obligatorio.')
  if (!ROLES.includes(role)) throw new HttpError(400, 'Rol inválido.')

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone },
  })
  if (error || !data.user) throw new HttpError(400, translateAuthError(error?.message ?? 'No se pudo crear el usuario.'))

  const { error: profileErr } = await admin
    .from('profiles')
    .update({ full_name: fullName, phone, role })
    .eq('id', data.user.id)

  if (profileErr) {
    console.error('create-user: fallo al actualizar el perfil, se revierte', profileErr.message)
    await admin.auth.admin.deleteUser(data.user.id)
    throw new HttpError(500, 'No se pudo completar el alta del usuario.')
  }

  return json({ user: { id: data.user.id, email: data.user.email } })
})
