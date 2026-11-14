import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

// NOT MOUNTED. AppLayout deliberately does not call this: a wearer's position
// comes from their phone, never from a browser, because a browser reports
// where a dashboard is open. Kept only so the option is visible rather than
// lost -- re-mounting it means accepting that a laptop at home will compete
// with the phone for the newest row in location_logs.
export function useLocationTracker() {
  const { user } = useAuth();

  useEffect(() => {
    // Only the people being looked after broadcast their location.
    //
    // This used to test for 'normal_user', which is not a role this system
    // has: the enum in models/User.js is ['user', 'elderly', 'caregiver'].
    // Both halves of the condition were therefore true for every one of the
    // 14 'user' accounts in the database, so the hook returned immediately
    // and the browser never once posted a fix for them -- only 'elderly'
    // accounts worked. The Flutter app checks 'user' and was always right;
    // this copy drifted.
    if (!user || (user.role !== 'user' && user.role !== 'elderly')) {
      return;
    }

    if (!navigator.geolocation) {
      console.warn('Geolocation is not supported by this browser.');
      return;
    }

    const sendLocation = (position) => {
      api.post('/location', {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        speed: position.coords.speed || 0,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('Failed to broadcast location:', err));
    };

    // Get initial position immediately
    navigator.geolocation.getCurrentPosition(sendLocation, (err) => {
      console.error('Error getting initial location:', err);
    });

    // Then watch for changes (use a 30s-1min interval or rely on watchPosition)
    // Using watchPosition for continuous tracking when active
    const watchId = navigator.geolocation.watchPosition(
      sendLocation,
      (err) => console.error('Error watching location:', err),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [user]);
}
