import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SelectedUserProvider } from './context/SelectedUserContext';
import Landing from './pages/Landing';

// Every route but the landing page is split out.
//
// All twenty-two pages used to be imported here, so opening "/" downloaded the
// whole application to show a marketing page: the dashboards, leaflet and
// react-leaflet behind the location map, socket.io-client behind the SOS
// listener and the chat, and every icon any page uses. None of it is reachable
// from "/" without a sign-in, and the landing page is the one route a first
// visitor is guaranteed to hit.
//
// Landing stays eager because it is what the first paint needs; splitting it
// would only add a round trip before anything appears.
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const AppLayout = lazy(() => import('./components/Layout/AppLayout'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const FamilyMembers = lazy(() => import('./pages/FamilyMembers'));
const FamilyMemberDetail = lazy(() => import('./pages/FamilyMemberDetail'));
const Medications = lazy(() => import('./pages/Medications'));
const Notifications = lazy(() => import('./pages/Notifications'));
const LocationMap = lazy(() => import('./pages/LocationMap'));
const ActivityFeed = lazy(() => import('./pages/ActivityFeed'));
const PastInteractions = lazy(() => import('./pages/PastInteractions'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const KeyframeAudit = lazy(() => import('./pages/KeyframeAudit'));
const UserDashboard = lazy(() => import('./pages/UserDashboard'));
const UserMedications = lazy(() => import('./pages/UserMedications'));
const UserHistory = lazy(() => import('./pages/UserHistory'));
const MemorySearch = lazy(() => import('./pages/MemorySearch'));
const Belongings = lazy(() => import('./pages/Belongings'));
const RelationshipsManage = lazy(() => import('./pages/RelationshipsManage'));
const Routine = lazy(() => import('./pages/Routine'));

// Plain markup, so the thing shown while a route arrives pulls in no
// component and no icon of its own.
function RouteFallback() {
  return (
    <div style={{
      minHeight: '60vh', display: 'grid', placeItems: 'center',
      color: 'var(--lc-text-muted, #6B645A)', font: '500 1rem/1.4 system-ui, sans-serif',
    }}>
      Loading...
    </div>
  );
}

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
          <Suspense fallback={<RouteFallback />}>
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

              {/* Shared monitoring & settings routes */}
              <Route path="activity" element={<ActivityFeed />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="keyframes" element={<KeyframeAudit />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="memory-search" element={<MemorySearch />} />
              {/* Enrolling an item is 10 to 15 photographs, which is work on a
                  phone and easy at a desk where a folder can be dropped in. */}
              <Route path="belongings" element={<Belongings />} />
              <Route path="routine" element={<Routine />} />
              {/* Shared, not caregiver-only. Both of these were reached from
                  pages every role can see -- "Saw <name>" in Memory Search and
                  "Manage relationships" in Settings -- but were gated to
                  caregivers, so a wearer who tapped either was bounced to
                  /my-dashboard and it looked like the link went to the dashboard
                  on purpose. The API never had that restriction: GET
                  /api/relationships reads req.user.id and only overrides it FOR
                  caregivers, so these are the wearer's own people. */}
              <Route path="interactions/:id" element={<PastInteractions />} />
              <Route path="relationships" element={<RelationshipsManage />} />

              {/* Normal user routes */}
              <Route path="my-dashboard" element={<UserOnlyRoute element={<UserDashboard />} />} />
              <Route path="my-medications" element={<UserOnlyRoute element={<UserMedications />} />} />
              <Route path="my-history" element={<UserOnlyRoute element={<UserHistory />} />} />
              <Route path="my-activity" element={<UserOnlyRoute element={<ActivityFeed />} />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </Router>
      </SelectedUserProvider>
    </AuthProvider>
  );
}

export default App;
