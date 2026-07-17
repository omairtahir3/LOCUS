import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import {
  LayoutDashboard, Users, Pill, Bell, MapPin, Activity,
  Settings, LogOut, Shield, Image, Clock, Home, Video
} from 'lucide-react';

const caregiverNavItems = [
  { path: '/dashboard',     icon: LayoutDashboard, label: 'Overview' },
  { path: '/family',        icon: Users,           label: 'Family Members' },
  { path: '/medications',   icon: Pill,            label: 'Medications' },
  { path: '/notifications', icon: Bell,            label: 'Notifications' },
];

const caregiverMonitorItems = [
  { path: '/keyframes', icon: Image,  label: 'Keyframe Audit' },
  { path: '/location',  icon: MapPin,   label: 'Location Map',   comingSoon: true },
  { path: '/activity',  icon: Activity, label: 'Activity Feed',  comingSoon: true },
];

const userNavItems = [
  { path: '/my-dashboard',   icon: Home,   label: 'My Dashboard' },
  { path: '/my-medications', icon: Pill,   label: 'My Medications' },
  { path: '/my-history',     icon: Clock,  label: 'History' },
  { path: '/notifications',  icon: Bell,   label: 'Notifications' },
];

const userMonitorItems = [
  { path: '/keyframes',      icon: Image,    label: 'Keyframe Audit' },
  { path: '/my-activity',    icon: Activity, label: 'Activity Feed', comingSoon: true },
  { path: '/memory-search',  icon: Shield,   label: 'Memory Search' },
];

export default function Sidebar({ isMobileOpen, closeMobile }) {
  const { logout, user } = useAuth();
  const location = useLocation();

  const isCaregiver = user?.role === 'caregiver' || user?.role === 'admin';

  const mainNav = isCaregiver ? caregiverNavItems : userNavItems;
  const monitorNav = isCaregiver ? caregiverMonitorItems : userMonitorItems;

  return (
    <>
      <div className={`sidebar-overlay ${isMobileOpen ? 'open' : ''}`} onClick={closeMobile} />
      <aside className={`sidebar ${isMobileOpen ? 'open' : ''}`}>
        <div className="sidebar-logo">
          <img src="/logo.png" alt="LOCUS" />
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section-label">Main</div>
          {mainNav.map(({ path, icon: Icon, label }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) => isActive ? 'active' : ''}
              end={path === '/' || path === '/my-dashboard'}
              onClick={closeMobile}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
        ))}

        {monitorNav.length > 0 && (
          <>
            <div className="sidebar-section-label">Monitoring</div>
            {monitorNav.map(({ path, icon: Icon, label, comingSoon }) => (
              <NavLink
                key={path}
                to={path}
                className={({ isActive }) => isActive ? 'active' : ''}
                onClick={e => {
                  if (comingSoon) e.preventDefault();
                  else closeMobile();
                }}
              >
                <Icon size={18} />
                <span>{label}</span>
                {comingSoon && <span className="dev-badge" style={{ fontSize: '10px' }}>Coming Soon</span>}
              </NavLink>
            ))}
          </>
        )}

        <div className="sidebar-spacer" />

        <div className="sidebar-section-label">Account</div>
        <NavLink to="/settings" onClick={closeMobile}>
          <Settings size={18} />
          <span>Settings</span>
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '0 4px' }}>
          {(user?.picture || user?.profile_picture) ? (
            <img src={user.picture || user.profile_picture} alt={user?.name || 'User'} className="avatar avatar-sm" style={{ objectFit: 'cover', borderRadius: '50%', border: '2px solid var(--primary)' }} />
          ) : (
            <div className="avatar avatar-sm" style={{ background: isCaregiver ? 'var(--primary)' : 'var(--accent)' }}>
              {user?.name?.charAt(0)?.toUpperCase() || 'U'}
            </div>
          )}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div className="text-sm font-bold truncate">{user?.name || 'User'}</div>
            <div className="text-xs text-muted truncate">{user?.email || ''}</div>
          </div>
        </div>
        <div style={{ padding: '0 4px', marginBottom: 6 }}>
          <span className={`badge ${isCaregiver ? 'badge-primary' : 'badge-info'}`} style={{ fontSize: '0.65rem' }}>
            {isCaregiver ? 'Caregiver' : 'User'}
          </span>
        </div>
        <button className="btn btn-ghost w-full btn-sm" onClick={logout}>
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
