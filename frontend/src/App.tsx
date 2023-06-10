import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Container } from '@mui/material';
import Header from './components/Header';
import Footer from './components/Footer';
import HomePage from './pages/HomePage';
import SearchPage from './pages/SearchPage';
import JourneysPage from './pages/JourneysPage';
import ProfilePage from './pages/ProfilePage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import AlertProvider from './providers/AlertProvider';
import AlertBar from './components/AlertBar';
import { AuthProvider } from './providers/AuthProvider';
import RouteGuard from './utils/RouteGuard';
import { client } from './utils/apiClient';
import { Provider } from 'urql';

export default function App() {
  return (
    <Provider value={client}>
      <AlertProvider>
        <AuthProvider>
          <Router>
            <Header />
            <Container maxWidth="md" sx={{ my: 4 }}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/search" element={<SearchPage />} />
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
            </Container>
            <Footer />
            <AlertBar />
          </Router>
        </AuthProvider>
      </AlertProvider>
    </Provider>
  );
}
