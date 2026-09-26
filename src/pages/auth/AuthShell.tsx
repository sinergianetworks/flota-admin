import { config } from '@/lib/config'
import { Card, CardContent } from '@/components/ui/card'
import Brand from '@/components/Brand'

export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Brand size="lg" className="inline-block mb-4" />
          <h1 className="text-2xl font-semibold text-gray-900">{config.appName}</h1>
        </div>
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="pt-6">{children}</CardContent>
        </Card>
      </div>
    </div>
  )
}
