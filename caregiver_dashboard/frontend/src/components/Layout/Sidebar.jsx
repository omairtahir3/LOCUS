import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import {
  LayoutDashboard, Users, Pill, Bell, MapPin, Activity,
  Settings, LogOut, Shield
} from 'lucide-react';

const navItems = [
  { path: '/',              icon: LayoutDashboard, label: 'Overview' },
  { path: '/family',        icon: Users,           label: 'Family Members' },
  { path: '/medications',   icon: Pill,            label: 'Medications' },
  { path: '/notifications', icon: Bell,            label: 'Notifications' },
];

const monitorItems = [
  { path: '/detection', icon: Shield, label: 'AI Detection' },
  { path: '/location',  icon: MapPin,   label: 'Location Map',   comingSoon: true },
  { path: '/activity',  icon: Activity, label: 'Activity Feed',  comingSoon: true },
];

export default function Sidebar() {
  const { logout, user } = useAuth();
  const location = useLocation();

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/logo.png" alt="LOCUS" />
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section-label">Main</div>
        {navItems.map(({ path, icon: Icon, label }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) => isActive ? 'active' : ''}
            end={path === '/'}
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}

        <div className="sidebar-section-label">Monitoring</div>
        {monitorItems.map(({ path, icon: Icon, label, comingSoon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) => isActive ? 'active' : ''}
          >
            <Icon size={18} />
            <span>{label}</span>
            {comingSoon && <span className="coming-soon-badge" style={{fontSize:'0.55rem',padding:'2px 6px',marginLeft:'auto'}}>Soon</span>}
          </NavLink>
        ))}

        <div className="sidebar-spacer" />

        <div className="sidebar-section-label">Account</div>
        <NavLink to="/settings">
          <Settings size={18} />
          <span>Settings</span>
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '0 4px' }}>
          <div className="avatar avatar-sm" style={{ background: 'var(--primary)' }}>
            {user?.name?.charAt(0)?.toUpperCase() || 'C'}
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div className="text-sm font-bold truncate">{user?.name || 'Caregiver'}</div>
            <div className="text-xs text-muted truncate">{user?.email || ''}</div>
          </div>
        </div>
        <button className="btn btn-ghost w-full btn-sm" onClick={logout}>
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
