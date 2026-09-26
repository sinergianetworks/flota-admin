import { config } from './config'

// Convierte #RRGGBB (o #RGB) a la tripleta "H S% L%" que usan las variables de
// shadcn/ui. Devuelve null si el valor no es un hex válido.
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  let m = hex.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(m)) m = m.split('').map(c => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(m)) return null

  const r = parseInt(m.slice(0, 2), 16) / 255
  const g = parseInt(m.slice(2, 4), 16) / 255
  const b = parseInt(m.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

// Aplica nombre, logo y color primario configurados al documento.
export function applyBranding() {
  document.title = config.appName

  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon && config.logoUrl) {
    icon.href = config.logoUrl
    icon.removeAttribute('type')
  }

  const hsl = config.primaryColor ? hexToHsl(config.primaryColor) : null
  if (!hsl) return
  const root = document.documentElement.style
  const value = `${hsl.h} ${hsl.s}% ${hsl.l}%`
  root.setProperty('--primary', value)
  root.setProperty('--ring', value)
  // Texto sobre el color primario: blanco salvo que el color sea muy claro.
  root.setProperty('--primary-foreground', hsl.l > 65 ? '240 10% 3.9%' : '0 0% 100%')
}
