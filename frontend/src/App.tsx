import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import HomePage from './pages/HomePage';
import SearchPage from './pages/SearchPage';
import JourneysPage from './pages/JourneysPage';
import ProfilePage from './pages/ProfilePage';
import { Container } from '@mui/material';

export default function App() {
  return (
    <React.Fragment>
      <Router>
        <Header />
        <Container maxWidth="md" sx={{ my: 4 }}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/journeys" element={<JourneysPage />} />
            <Route path="/profile" element={<ProfilePage />} />
          </Routes></Container>
        <Footer />
      </Router>
    </React.Fragment>
  );
}
