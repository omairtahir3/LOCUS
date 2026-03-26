import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import AppLayout from './components/Layout/AppLayout';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import FamilyMembers from './pages/FamilyMembers';
import FamilyMemberDetail from './pages/FamilyMemberDetail';
import Medications from './pages/Medications';
import Notifications from './pages/Notifications';
import LocationMap from './pages/LocationMap';
import ActivityFeed from './pages/ActivityFeed';
import Detection from './pages/Detection';
import SettingsPage from './pages/Settings';

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Protected routes */}
          <Route element={<AppLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="family" element={<FamilyMembers />} />
            <Route path="family/:userId" element={<FamilyMemberDetail />} />
            <Route path="medications" element={<Medications />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="location" element={<LocationMap />} />
            <Route path="activity" element={<ActivityFeed />} />
            <Route path="detection" element={<Detection />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
