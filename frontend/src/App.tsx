import { lazy, Suspense } from 'react';
import { createBrowserRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { Box, Container } from '@mui/material';
import Header from './components/Header';
import Footer from './components/Footer';
import SeoMeta from './components/SeoMeta';
import HomePage from './pages/HomePage';
import AlertProvider from './providers/AlertProvider';
import AlertBar from './components/AlertBar';
import { AuthProvider } from './providers/AuthProvider';
import RouteGuard from './utils/RouteGuard';
import { client } from './utils/apiClient';
import { Provider } from 'urql';
import LoadingStatus from './components/LoadingStatus';

// Lazy-load routed page components to reduce initial bundle size.
// Auth-protected pages (search, journeys, profile) only fetch their
// chunk after login; forgot/reset password pages are publicly accessible.
const SearchPage = lazy(() => import('./pages/SearchPage'));
const JourneysPage = lazy(() => import('./pages/JourneysPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));

function PageLoader() {
  return <LoadingStatus label="Loading page…" />;
}

function AppLayout() {
  return (
    <>
      <SeoMeta />
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <Box
          component="a"
          href="#main-content"
          sx={{
            position: 'absolute',
            left: 8,
            top: 8,
            zIndex: 2000,
            transform: 'translateY(-200%)',
            bgcolor: 'background.paper',
            color: 'primary.main',
            px: 2,
            py: 1,
            borderRadius: 1,
            boxShadow: 2,
            '&:focus-visible': { transform: 'translateY(0)' },
          }}
        >
          Skip to main content
        </Box>
        <Header />
        <Container component="main" id="main-content" maxWidth="md" sx={{ my: 4, flex: 1 }}>
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
    </>
  );
}

const router = createBrowserRouter([{ path: '*', element: <AppLayout /> }]);

export default function App() {
  return (
    <Provider value={client}>
      <AlertProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </AlertProvider>
    </Provider>
  );
}
