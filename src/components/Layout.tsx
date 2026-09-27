import { NavLink, Outlet, useMatch } from 'react-router-dom'
import { useState } from 'react'
import { Truck, Users, LogOut, Menu, KeyRound, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { config } from '@/lib/config'
import { getInitials } from '@/lib/format'
import { ROLE_LABELS } from '@/types'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import Brand from './Brand'

function NavItem({ to, icon: Icon, label }: { to: string; icon: LucideIcon; label: string }) {
  const match = useMatch({ path: to, end: false })
  return (
    <Button asChild variant={match ? 'secondary' : 'ghost'} className="w-full justify-start gap-2" size="sm">
      <NavLink to={to}>
        <Icon size={18} />
        <span className="flex-1 text-left">{label}</span>
      </NavLink>
    </Button>
  )
}

export default function Layout() {
  const { profile, signOut, isAdmin } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)

  const nav = [
    { to: '/vehiculos', icon: Truck, label: 'Vehículos', show: true },
    { to: '/usuarios', icon: Users, label: 'Usuarios', show: isAdmin },
    { to: '/configuracion', icon: Settings, label: 'Configuración', show: isAdmin },
  ].filter(item => item.show)

  const sidebarContent = (onNavClick?: () => void) => (
    <>
      <div className="p-4 flex items-center gap-3">
        <Brand />
        <p className="text-sm font-semibold leading-tight">{config.appName}</p>
      </div>

      <nav className="flex-1 px-3 space-y-1">
        {nav.map(item => (
          <div key={item.to} onClick={onNavClick}>
            <NavItem {...item} />
          </div>
        ))}
      </nav>

      <div className="px-3 pb-4">
        <Separator className="mb-3" />
        <div className="flex items-center gap-3 px-3 py-2">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback className="text-xs">{getInitials(profile?.full_name)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{profile?.full_name}</p>
            <p className="text-xs text-muted-foreground">{profile ? ROLE_LABELS[profile.role] : ''}</p>
          </div>
        </div>
        <Button asChild variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
          <NavLink to="/nueva-contrasena" onClick={onNavClick}>
            <KeyRound size={18} />
            Cambiar contraseña
          </NavLink>
        </Button>
        <Button variant="ghost" size="sm" onClick={signOut} className="w-full justify-start gap-2 text-muted-foreground">
          <LogOut size={18} />
          Cerrar sesión
        </Button>
      </div>
    </>
  )

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col md:flex-row">
      <header className="md:hidden bg-background border-b px-4 py-3 sticky top-0 z-30 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Brand size="sm" />
          <span className="font-semibold text-sm truncate">{config.appName}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Abrir menú">
          <Menu size={20} />
        </Button>
      </header>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-60 p-0 flex flex-col">
          <SheetTitle className="sr-only">Navegación</SheetTitle>
          {sidebarContent(() => setMobileOpen(false))}
        </SheetContent>
      </Sheet>

      <aside className="hidden md:flex w-56 bg-background border-r flex-col sticky top-0 h-screen overflow-y-auto shrink-0">
        {sidebarContent()}
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
