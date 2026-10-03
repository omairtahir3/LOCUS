import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

export function useSocketSOS() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [socket, setSocket] = useState(null);
  const [activeSOS, setActiveSOS] = useState(null);

  useEffect(() => {
    // Everyone signed in gets a socket now, not just caregivers. The elderly
    // side needs one to be CALLED: a voice channel has to be reachable from
    // the other end, and a client with no connection cannot be rung. The SOS
    // handlers below stay caregiver-only, since those are alerts about someone
    // rather than alerts for them.
    if (!user) return;

    const token = localStorage.getItem('locus_token');
    const newSocket = io(import.meta.env.VITE_API_URL || 'http://localhost:5000', {
      transports: ['websocket'],
      auth: { token }
    });

    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('[Socket] Connected securely');
    });

    newSocket.on('connect_error', (err) => {
      console.error('[Socket] Connection Error:', err.message);
    });

    if (user.role !== 'caregiver') {
      // Connected and reachable, but not listening for alerts about others.
      return () => { newSocket.disconnect(); };
    }

    newSocket.on('sos_alert', (data) => {
      console.warn('[Socket] SOS Alert Received:', data);
      setActiveSOS({
        userId: data.user_id,
        userName: data.user_name,
        isEmergency: true
      });
      // Auto-redirect to location map
      navigate('/location', { state: { sos: true, ...data } });
    });

    newSocket.on('sos_resolved', (data) => {
      const resolver = data.resolved_by === 'user' ? 'the user themselves' : (data.resolver_name || 'a caregiver');
      alert(`Emergency for ${data.user_name} was resolved by ${resolver}.`);
      setActiveSOS(null);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [user, navigate]);

  return { socket, activeSOS, setActiveSOS };
}
