import { MapPin, Navigation, AlertTriangle, Shield } from 'lucide-react';

export default function LocationMap() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Location Map</h2>
          <p className="page-description">Real-time family member location tracking</p>
        </div>
        <span className="coming-soon-badge"><Shield size={12} /> Coming Soon</span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', borderRadius: 'var(--radius-lg)' }}>
        {/* Mock map */}
        <div style={{
          height: 500, background: 'linear-gradient(135deg, #E0F2FE 0%, #CCFBF1 50%, #F0FDF4 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16,
          position: 'relative',
        }}>
          {/* Grid lines to simulate map */}
          <div style={{
            position: 'absolute', inset: 0, opacity: 0.15,
            backgroundImage: 'linear-gradient(var(--text-muted) 1px, transparent 1px), linear-gradient(90deg, var(--text-muted) 1px, transparent 1px)',
            backgroundSize: '60px 60px',
          }} />
          
          {/* Mock location pin */}
          <div style={{
            background: 'var(--primary)', width: 56, height: 56, borderRadius: '50% 50% 50% 0',
            transform: 'rotate(-45deg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(13, 148, 136, 0.3)', animation: 'pulse 2s infinite',
          }}>
            <MapPin size={24} style={{ transform: 'rotate(45deg)', color: 'white' }} />
          </div>
          
          <div style={{ textAlign: 'center', zIndex: 1 }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Location Tracking</h3>
            <p className="text-muted text-sm" style={{ maxWidth: 360 }}>
              Real-time GPS tracking, geofence alerts, and "I'm Lost" emergency mode will be available when the location backend is connected.
            </p>
          </div>
        </div>
      </div>

      {/* Feature preview cards */}
      <div className="stat-grid mt-4">
        <div className="stat-card">
          <div className="stat-icon primary"><MapPin size={20} /></div>
          <div>
            <div className="stat-label" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Live Tracking</div>
            <div className="text-xs text-muted">Real-time GPS location on interactive map</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon warning"><AlertTriangle size={20} /></div>
          <div>
            <div className="stat-label" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Geofence Alerts</div>
            <div className="text-xs text-muted">Get notified when family member leaves safe zones</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon danger"><Navigation size={20} /></div>
          <div>
            <div className="stat-label" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Emergency Mode</div>
            <div className="text-xs text-muted">"I'm Lost" panic button with guided navigation</div>
          </div>
        </div>
      </div>
    </div>
  );
}
