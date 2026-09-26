// Clientes de Supabase y autorización para las edge functions.
//
// Las funciones se despliegan con verify_jwt = false (el check de la
// plataforma solo entiende las keys legacy) y autorizan aquí, en código.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''

// Lee una key nueva (JSON { nombre: key }) con fallback a la legacy.
function readKey(newVar: string, legacyVar: string): string {
  const raw = Deno.env.get(newVar)
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, string>
      const key = keys['default'] ?? Object.values(keys)[0]
      if (key) return key
    } catch { /* formato inesperado: se usa la legacy */ }
  }
  return Deno.env.get(legacyVar) ?? ''
}

export const SECRET_KEY = readKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')

// Cliente con la secret key: ignora la RLS. Usar solo después de autorizar.
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export type Role = 'admin' | 'driver'

export interface Caller {
  user: User
  role: Role
  token: string
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

// Valida la sesión del usuario que llama y devuelve su rol. Lanza 401 si no
// hay sesión válida y 403 si el usuario está desactivado o no tiene perfil.
export async function requireUser(req: Request, admin = adminClient()): Promise<Caller> {
  const token = bearerToken(req)
  if (!token) throw new HttpError(401, 'No autenticado')

  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Sesión inválida o expirada')

  const { data: profile } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', data.user.id)
    .maybeSingle()
  if (!profile || !profile.active) throw new HttpError(403, 'Usuario sin acceso')

  return { user: data.user, role: profile.role as Role, token }
}

export async function requireAdmin(req: Request, admin = adminClient()): Promise<Caller> {
  const caller = await requireUser(req, admin)
  if (caller.role !== 'admin') throw new HttpError(403, 'Solo un administrador puede hacer esto')
  return caller
}

// Cliente que actúa como el usuario que llama: respeta su RLS.
export function userClient(token: string): SupabaseClient {
  const publishable = readKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
  return createClient(SUPABASE_URL, publishable, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
