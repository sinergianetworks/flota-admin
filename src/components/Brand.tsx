import { config } from '@/lib/config'
import { cn } from '@/lib/utils'

export default function Brand({ size = 'md', className }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const img = { sm: 'w-7 h-7 rounded-lg', md: 'w-8 h-8 rounded-lg', lg: 'w-14 h-14 rounded-2xl' }[size]
  return (
    <img
      src={config.logoUrl}
      alt={config.appName}
      className={cn(img, 'object-contain shrink-0', className)}
    />
  )
}
