import { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

export function useLocationTracker() {
  const { user } = useAuth();

  useEffect(() => {
    // Only normal users and elderly users broadcast their location
    if (!user || (user.role !== 'normal_user' && user.role !== 'elderly')) {
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
