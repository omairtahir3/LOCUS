import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { MapPin, Navigation, AlertTriangle, Shield, Package, MessageCircle } from 'lucide-react';
import LocationMapComponent from '../components/LocationMap';
import api, { userItemsAPI } from '../services/api';

import { useSelectedUser } from '../context/SelectedUserContext';
import { useAuth } from '../context/AuthContext';
import PageHeader from '../components/Layout/PageHeader';

export default function LocationMap() {
  const [locationData, setLocationData] = useState(null);
  // Where each belonging was last seen (FE 10-4). Its own request, so a
  // belongings failure never blanks the person's position.
  const [itemPins, setItemPins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { openEmergencyChat, socket } = useOutletContext();
  const [resolving, setResolving] = useState(false);
  // Set when somebody ELSE ends this emergency. See the effect below.
  const [resolvedElsewhere, setResolvedElsewhere] = useState(false);
  
  const { user } = useAuth();
  const selectedUserContext = useSelectedUser();
  const selectedUser = selectedUserContext?.selectedUser;

  // Check if we arrived here from an SOS alert
  const sosData = (!resolvedElsewhere && location.state?.sos) ? location.state : null;

  // An emergency ends once, for everybody.
  //
  // sosData is derived from the router's navigation state, which is immutable
  // and was never cleared by anything but this page's own Resolve button. So
  // when the emergency was resolved on the PHONE -- by the wearer pressing
  // "I'm safe now", or by a caregiver on the mobile app -- this browser went
  // on showing the red banner over the map indefinitely, and the two
  // dashboards disagreed about whether anyone was still in trouble.
  //
  // The server already emits sos_resolved to every socket in the caregiver's
  // room; nothing on this page was listening for it.
  useEffect(() => {
    if (!socket || !location.state?.sos) return;
    const onResolved = (d) => {
      const who = String(d?.user_id ?? d?.userId ?? '');
      if (!who || who === String(location.state.user_id)) setResolvedElsewhere(true);
    };
    socket.on('sos_resolved', onResolved);
    return () => socket.off('sos_resolved', onResolved);
  }, [socket, location.state]);
  
  // The chat no longer opens itself.
  //
  // An SOS sends the caregiver to this page to see WHERE the person is, and
  // this effect then slid a 390px chat panel over it -- the full width of a
  // narrow window, because .chat-overlay was min(390px, 100vw). The one thing
  // they came for was covered by the first thing they had to dismiss.
  //
  // The banner carries a Message button instead, so the chat opens when the
  // caregiver decides they want to type rather than look.

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
    
    const fetchItemPins = async () => {
      try {
        const res = await userItemsAPI.lastSeenAll(selectedUser?._id);
        setItemPins(res.data?.items || []);
      } catch {
        // A belonging with no sighting is the normal case indoors, and this
        // must never be the reason the map does not draw.
        setItemPins([]);
      }
    };

    fetchLocation();
    fetchItemPins();

    // Auto refresh every 30 seconds
    const interval = setInterval(() => { fetchLocation(); fetchItemPins(); }, 30000);
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
      <PageHeader
        title="Location Map"
        description="Real-time family member location tracking"
      />

      {sosData && (
        <div className="sos-banner">
          <span className="sos-banner-pulse" aria-hidden="true">
            <AlertTriangle size={22} />
          </span>
          <div className="sos-banner-text">
            <h2>Emergency &mdash; {sosData.user_name}</h2>
            <p>
              They raised an SOS. The map below follows their position as the
              phone reports it.
            </p>
          </div>
          <div className="sos-banner-actions">
            {/* Secondary, and deliberately not opened for them: looking at
                the map is why they are here. */}
            <button
              className="btn sos-btn-ghost"
              onClick={() => {
                if (openEmergencyChat) openEmergencyChat(sosData.user_id, sosData.user_name);
              }}
            >
              <MessageCircle size={15} aria-hidden="true" /> Message
            </button>
            <button
              className="btn sos-btn-solid"
              onClick={handleResolveSOS}
              disabled={resolving}
            >
              {resolving ? 'Resolving…' : 'Mark resolved'}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 16, overflow: 'hidden', borderRadius: 'var(--radius-lg)' }}>
        {loading ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p>Loading GPS Data...</p>
          </div>
        ) : error ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: 'var(--danger-text)' }}>
            <MapPin size={48} style={{ opacity: 0.5, marginBottom: 16 }} />
            <p>{error}</p>
          </div>
        ) : locationData ? (
          <LocationMapComponent 
            lat={locationData.lat} 
            lng={locationData.lng} 
            timestamp={locationData.timestamp} 
            items={itemPins}
          />
        ) : null}
      </div>

      {/* Where each belonging was last seen, matching the amber dots on the map.
          This replaced three cards advertising "Geofence Alerts" and "guided
          navigation", neither of which exists: a label is not a feature, and on
          a page a caregiver opens in an emergency it is worse than empty. */}
      <div className="card mt-4" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Package size={16} style={{ color: '#F59E0B' }} />
          <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Belongings last seen</div>
        </div>
        {itemPins.length === 0 ? (
          <p className="text-xs text-muted" style={{ margin: 0 }}>
            No belongings have been sighted with a GPS fix in the last three days.
            Indoors there is often no fix to record, which is normal.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {itemPins.map(it => (
              <div key={it.item_id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                paddingBottom: 8, borderBottom: '1px solid var(--border)',
              }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%', background: '#F59E0B',
                  border: '2px solid #fff', boxShadow: '0 0 0 1px var(--border)', flexShrink: 0,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {it.name}
                  </div>
                  <div className="text-xs text-muted">
                    {new Date(it.at).toLocaleString('en-US', {
                      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
                    })}
                    {it.placement === 'in_hand' ? ' · was being carried' : ''}
                  </div>
                </div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${it.location.lat},${it.location.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs"
                  style={{ color: 'var(--primary-text)', textDecoration: 'none', whiteSpace: 'nowrap' }}
                >
                  Open in Maps
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
