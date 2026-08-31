import { useLocation } from 'react-router-dom';
import { Bell, Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const pageTitles = {
  '/':              'Dashboard Overview',
  '/family':        'Family Members',
  '/medications':   'Medication Management',
  '/notifications': 'Notifications',
  '/location':      'Location Map',
  '/activity':      'Activity Feed',
  '/settings':      'Settings',
  '/keyframes':     'Keyframe Audit',
  '/my-dashboard':  'My Dashboard',
  '/my-medications':'My Medications',
  '/my-history':    'Medication History',
};

export default function Topbar() {
  const location = useLocation();
  const path = location.pathname;
  const { user } = useAuth();

  // Handle dynamic routes
  let title = pageTitles[path] || 'Dashboard';
  if (path.startsWith('/family/')) title = 'Family Member Details';

  return (
    <header className="topbar" style={{ position: 'fixed', top: 0, left: '260px', width: 'calc(100vw - 260px)', display: 'flex', alignItems: 'center', paddingLeft: '40px', zIndex: 1000, backgroundColor: '#ffffff', borderBottom: '1px solid var(--border)' }}>
      <h1 className="topbar-title" style={{ margin: 0, flex: 1 }}>{title}</h1>
      <div className="topbar-right" style={{ position: 'absolute', right: '40px', display: 'flex', alignItems: 'center', gap: '16px' }}>
        
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            className="form-input"
            placeholder="Search..."
            style={{ width: 220, paddingLeft: 36, fontSize: '0.85rem', height: 38 }}
          />
          <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        </div>
      </div>
    </header>
  );
}
