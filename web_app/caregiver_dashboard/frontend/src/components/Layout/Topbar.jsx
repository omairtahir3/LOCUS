import { useLocation } from 'react-router-dom';
import { Bell, Search } from 'lucide-react';

const pageTitles = {
  '/':              'Dashboard Overview',
  '/family':        'Family Members',
  '/medications':   'Medication Management',
  '/notifications': 'Notifications',
  '/location':      'Location Map',
  '/activity':      'Activity Feed',
  '/settings':      'Settings',
  '/detection':     'AI Detection',
  '/keyframes':     'Keyframe Audit',
  '/my-dashboard':  'My Dashboard',
  '/my-medications':'My Medications',
  '/my-history':    'Medication History',
};

export default function Topbar() {
  const location = useLocation();
  const path = location.pathname;

  // Handle dynamic routes
  let title = pageTitles[path] || 'Dashboard';
  if (path.startsWith('/family/')) title = 'Family Member Details';

  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-right">
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
