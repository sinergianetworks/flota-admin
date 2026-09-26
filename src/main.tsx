import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import 'leaflet/dist/leaflet.css'
import App from './App.tsx'
import AuthProvider from './hooks/AuthProvider'
import { missingConfig } from './lib/config'
import { applyBranding } from './lib/branding'
import ConfigMissingPage from './pages/ConfigMissingPage'

applyBranding()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {missingConfig.length > 0 ? (
      <ConfigMissingPage missing={missingConfig} />
    ) : (
      <AuthProvider>
        <App />
      </AuthProvider>
    )}
  </StrictMode>,
)
