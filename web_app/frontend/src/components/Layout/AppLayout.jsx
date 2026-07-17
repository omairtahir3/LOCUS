import { useState } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Menu, X } from 'lucide-react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

export default function AppLayout() {
  const { user, token } = useAuth();
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  if (!token) return <Navigate to="/login" replace />;

  return (
    <div className="app-layout">
      {/* Mobile Header Overlay */}
      <div className="mobile-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/logo.png" alt="LOCUS" style={{ height: 24, objectFit: 'contain' }} />
          <span style={{ fontWeight: 800, fontSize: '1.2rem', letterSpacing: '-0.02em' }}>LOCUS</span>
        </div>
        <button className="btn btn-icon btn-ghost" onClick={() => setIsMobileOpen(!isMobileOpen)}>
          {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      <Sidebar isMobileOpen={isMobileOpen} closeMobile={() => setIsMobileOpen(false)} />

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
