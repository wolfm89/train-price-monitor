import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Container } from '@mui/material';
import Header from './components/Header';
import Footer from './components/Footer';
import HomePage from './pages/HomePage';
import SearchPage from './pages/SearchPage';
import JourneysPage from './pages/JourneysPage';
import ProfilePage from './pages/ProfilePage';
import AlertProvider from './providers/AlertProvider';
import AlertBar from './components/AlertBar';

export default function App() {
  return (
    <AlertProvider>
      <Router>
        <Header />
        <Container maxWidth="md" sx={{ my: 4 }}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/journeys" element={<JourneysPage />} />
            <Route path="/profile" element={<ProfilePage />} />
          </Routes>
        </Container>
        <Footer />
        <AlertBar />
      </Router>
    </AlertProvider>
  );
}
