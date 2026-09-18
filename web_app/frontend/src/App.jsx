import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SelectedUserProvider } from './context/SelectedUserContext';
import AppLayout from './components/Layout/AppLayout';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import FamilyMembers from './pages/FamilyMembers';
import FamilyMemberDetail from './pages/FamilyMemberDetail';
import Medications from './pages/Medications';
import Notifications from './pages/Notifications';
import LocationMap from './pages/LocationMap';
import ActivityFeed from './pages/ActivityFeed';
import PastInteractions from './pages/PastInteractions';


import SettingsPage from './pages/Settings';
import KeyframeAudit from './pages/KeyframeAudit';
import UserDashboard from './pages/UserDashboard';
import UserMedications from './pages/UserMedications';
import UserHistory from './pages/UserHistory';
import MemorySearch from './pages/MemorySearch';
import RelationshipsManage from './pages/RelationshipsManage';

function CaregiverOnlyRoute({ element }) {
  const { user } = useAuth();
  if (user && user.role !== 'caregiver' && user.role !== 'admin') {
    return <Navigate to="/my-dashboard" replace />;
  }
  return element;
}

function UserOnlyRoute({ element }) {
  const { user } = useAuth();
  if (user && (user.role === 'caregiver' || user.role === 'admin')) {
    return <Navigate to="/dashboard" replace />;
  }
  return element;
}

function App() {
  return (
    <AuthProvider>
      <SelectedUserProvider>
        <Router>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="login" element={<Login />} />
            <Route path="register" element={<Register />} />
            <Route path="reset-password" element={<ResetPassword />} />
            
            <Route element={<AppLayout />}>
              {/* Caregiver routes */}
              <Route path="dashboard" element={<CaregiverOnlyRoute element={<Dashboard />} />} />
              <Route path="family" element={<CaregiverOnlyRoute element={<FamilyMembers />} />} />
              <Route path="family/:userId" element={<CaregiverOnlyRoute element={<FamilyMemberDetail />} />} />
              <Route path="medications" element={<CaregiverOnlyRoute element={<Medications />} />} />
              <Route path="location" element={<CaregiverOnlyRoute element={<LocationMap />} />} />
              <Route path="interactions/:id" element={<CaregiverOnlyRoute element={<PastInteractions />} />} />
              <Route path="relationships" element={<CaregiverOnlyRoute element={<RelationshipsManage />} />} />

              {/* Shared monitoring & settings routes */}
              <Route path="activity" element={<ActivityFeed />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="keyframes" element={<KeyframeAudit />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="memory-search" element={<MemorySearch />} />

              {/* Normal user routes */}
              <Route path="my-dashboard" element={<UserOnlyRoute element={<UserDashboard />} />} />
              <Route path="my-medications" element={<UserOnlyRoute element={<UserMedications />} />} />
              <Route path="my-history" element={<UserOnlyRoute element={<UserHistory />} />} />
              <Route path="my-activity" element={<UserOnlyRoute element={<ActivityFeed />} />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </SelectedUserProvider>
    </AuthProvider>
  );
}

export default App;
