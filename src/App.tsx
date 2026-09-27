import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/auth/LoginPage'
import NewPasswordPage from './pages/auth/NewPasswordPage'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import PageLoader from './components/PageLoader'

// Leaflet y recharts: se cargan solo al entrar
const VehiclesPage = lazy(() => import('./pages/vehicles/VehiclesPage'))
const UsersPage = lazy(() => import('./pages/users/UsersPage'))
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/nueva-contrasena" element={<NewPasswordPage />} />

          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/vehiculos" element={<VehiclesPage />} />
            <Route
              path="/usuarios"
              element={
                <ProtectedRoute roles={['admin']}>
                  <UsersPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/configuracion"
              element={
                <ProtectedRoute roles={['admin']}>
                  <SettingsPage />
                </ProtectedRoute>
              }
            />
          </Route>

          <Route path="*" element={<Navigate to="/vehiculos" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
