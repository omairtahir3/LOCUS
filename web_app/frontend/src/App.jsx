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
import KeyframeAudit from './pages/KeyframeAudit';
import UserDashboard from './pages/UserDashboard';
import UserMedications from './pages/UserMedications';
import UserHistory from './pages/UserHistory';
import MemorySearch from './pages/MemorySearch';

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Protected routes (role-aware sidebar handles nav) */}
          <Route element={<AppLayout />}>
            {/* Caregiver routes */}
            <Route index element={<Dashboard />} />
            <Route path="family" element={<FamilyMembers />} />
            <Route path="family/:userId" element={<FamilyMemberDetail />} />
            <Route path="medications" element={<Medications />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="location" element={<LocationMap />} />
            <Route path="activity" element={<ActivityFeed />} />
            <Route path="detection" element={<Detection />} />
            <Route path="keyframes" element={<KeyframeAudit />} />
            <Route path="settings" element={<SettingsPage />} />

            {/* Normal user routes */}
            <Route path="my-dashboard" element={<UserDashboard />} />
            <Route path="my-medications" element={<UserMedications />} />
            <Route path="my-history" element={<UserHistory />} />
            <Route path="my-activity" element={<ActivityFeed />} />
            <Route path="my-detection" element={<Detection />} />
            <Route path="memory-search" element={<MemorySearch />} />
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
