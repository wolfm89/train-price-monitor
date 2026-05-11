import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Box, CircularProgress, Container } from '@mui/material';
import Header from './components/Header';
import Footer from './components/Footer';
import HomePage from './pages/HomePage';
import AlertProvider from './providers/AlertProvider';
import AlertBar from './components/AlertBar';
import { AuthProvider } from './providers/AuthProvider';
import RouteGuard from './utils/RouteGuard';
import { client } from './utils/apiClient';
import { Provider } from 'urql';

// Lazy-load routed page components to reduce initial bundle size.
// Auth-protected pages (search, journeys, profile) only fetch their
// chunk after login; forgot/reset password pages are publicly accessible.
const SearchPage = lazy(() => import('./pages/SearchPage'));
const JourneysPage = lazy(() => import('./pages/JourneysPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));

function PageLoader() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 100 }}>
      <CircularProgress />
    </Box>
  );
}

export default function App() {
  return (
    <Provider value={client}>
      <AlertProvider>
        <AuthProvider>
          <Router>
            <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
              <Header />
              <Container component="main" maxWidth="md" sx={{ my: 4, flex: 1 }}>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route path="/" element={<HomePage />} />
                    <Route
                      path="/search"
                      element={
                        <RouteGuard>
                          <SearchPage />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="/journeys"
                      element={
                        <RouteGuard>
                          <JourneysPage />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="/profile"
                      element={
                        <RouteGuard>
                          <ProfilePage />
                        </RouteGuard>
                      }
                    />
                    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                    <Route path="/reset-password" element={<ResetPasswordPage />} />
                  </Routes>
                </Suspense>
              </Container>
              <Footer />
            </Box>
            <AlertBar />
          </Router>
        </AuthProvider>
      </AlertProvider>
    </Provider>
  );
}
