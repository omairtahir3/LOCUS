import React, { useState, useEffect } from 'react';
import { MapPin, Navigation, AlertTriangle, Shield } from 'lucide-react';
import LocationMapComponent from '../components/LocationMap';
import api from '../services/api';

export default function LocationMap() {
  const [locationData, setLocationData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchLocation = async () => {
      try {
        // Fetch latest location
        const res = await api.get('/location/latest');
        setLocationData(res.data);
      } catch (err) {
        if (err.response && err.response.status === 404) {
          setError("No location data found yet.");
        } else {
          setError("Failed to fetch location data.");
        }
      } finally {
        setLoading(false);
      }
    };
    
    fetchLocation();
    
    // Auto refresh every 30 seconds
    const interval = setInterval(fetchLocation, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Location Map</h2>
          <p className="page-description">Real-time family member location tracking</p>
        </div>
      </div>

      <div className="card" style={{ padding: 16, overflow: 'hidden', borderRadius: 'var(--radius-lg)' }}>
        {loading ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p>Loading GPS Data...</p>
          </div>
        ) : error ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: 'var(--danger)' }}>
            <MapPin size={48} style={{ opacity: 0.5, marginBottom: 16 }} />
            <p>{error}</p>
          </div>
        ) : locationData ? (
          <LocationMapComponent 
            lat={locationData.lat} 
            lng={locationData.lng} 
            timestamp={locationData.timestamp} 
          />
        ) : null}
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
