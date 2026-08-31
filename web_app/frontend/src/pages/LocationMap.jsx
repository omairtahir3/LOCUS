import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { MapPin, Navigation, AlertTriangle, Shield } from 'lucide-react';
import LocationMapComponent from '../components/LocationMap';
import api from '../services/api';
import UserSelector from '../components/Layout/UserSelector';

import { useSelectedUser } from '../context/SelectedUserContext';
import { useAuth } from '../context/AuthContext';

export default function LocationMap() {
  const [locationData, setLocationData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { openEmergencyChat } = useOutletContext();
  const [resolving, setResolving] = useState(false);
  
  const { user } = useAuth();
  const selectedUserContext = useSelectedUser();
  const selectedUser = selectedUserContext?.selectedUser;

  // Check if we arrived here from an SOS alert
  const sosData = location.state?.sos ? location.state : null;
  
  useEffect(() => {
    if (sosData && openEmergencyChat) {
      // Ensure chat is opened for this emergency even if the page is reloaded
      openEmergencyChat(sosData.user_id, sosData.user_name);
    }
  }, [sosData]); // intentionally omitting openEmergencyChat to prevent loops

  useEffect(() => {
    // If it's a caregiver, wait for selectedUser to be populated
    if (user?.role === 'caregiver' && !selectedUser && !sosData) return;

    const fetchLocation = async () => {
      try {
        if (sosData) {
           // If we have SOS data, use that location immediately
           setLocationData({ lat: sosData.location.lat, lng: sosData.location.lng, timestamp: sosData.timestamp });
           setLoading(false);
           return;
        }

        // Fetch latest location
        const url = selectedUser ? `/location/latest?user_id=${selectedUser._id}` : '/location/latest';
        const res = await api.get(url);
        setLocationData(res.data);
        setError(null);
      } catch (err) {
        if (err.response && err.response.status === 404) {
          setError("No location data found yet.");
        } else {
          setError("Failed to fetch location data.");
        }
        setLocationData(null);
      } finally {
        setLoading(false);
      }
    };
    
    fetchLocation();
    
    // Auto refresh every 30 seconds
    const interval = setInterval(fetchLocation, 30000);
    return () => clearInterval(interval);
  }, [sosData, selectedUser, user]);

  const handleResolveSOS = async () => {
    if (!sosData) return;
    setResolving(true);
    try {
      await api.delete(`/users/${sosData.user_id}/emergency`);
      alert("Emergency resolved.");
      // Clear state
      navigate('/location', { replace: true, state: {} });
    } catch (err) {
      alert("Failed to resolve emergency.");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 className="page-title">Location Map</h2>
          <p className="page-description">Real-time family member location tracking</p>
        </div>
        <UserSelector />
      </div>

      {sosData && (
        <div style={{ backgroundColor: 'var(--danger)', color: 'white', padding: 20, borderRadius: 16, marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertTriangle /> EMERGENCY SOS ACTIVE
              </h3>
              <p style={{ margin: '8px 0 0 0', opacity: 0.9 }}>
                {sosData.user_name} triggered an SOS. Location updated automatically.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button 
                className="btn" 
                style={{ backgroundColor: 'transparent', color: 'white', border: '1px solid white', fontWeight: 'bold' }}
                onClick={() => {
                  if (openEmergencyChat) openEmergencyChat(sosData.user_id, sosData.user_name);
                }}
              >
                Open Chat
              </button>
              <button 
                className="btn" 
                style={{ backgroundColor: 'white', color: 'var(--danger)', fontWeight: 'bold' }}
                onClick={handleResolveSOS}
                disabled={resolving}
              >
                {resolving ? 'Resolving...' : 'Acknowledge & Resolve'}
              </button>
            </div>
          </div>
        </div>
      )}

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
