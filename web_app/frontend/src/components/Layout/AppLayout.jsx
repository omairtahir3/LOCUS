import { useState } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Menu, X } from 'lucide-react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import { useKeyframeSync } from '../../hooks/useKeyframeSync';

export default function AppLayout() {
  const { user, token } = useAuth();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  
  // Start syncing keyframes in the background
  useKeyframeSync();

  if (!token) return <Navigate to="/login" replace />;

  return (
    <div className="app-layout">
      {/* Mobile Header Overlay */}
      <div className="mobile-header">
        <button className="btn btn-icon btn-ghost" onClick={() => setIsMobileOpen(!isMobileOpen)} style={{ padding: 4, zIndex: 110 }}>
          {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
        <img src="/logo.png" alt="LOCUS" style={{ height: 24, objectFit: 'contain', position: 'absolute', left: '50%', transform: 'translateX(-50%)', zIndex: 100 }} />
      </div>

      <Sidebar isMobileOpen={isMobileOpen} closeMobile={() => setIsMobileOpen(false)} />

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
