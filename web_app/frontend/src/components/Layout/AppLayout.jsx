import { useState } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Menu, X } from 'lucide-react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import { useKeyframeSync } from '../../hooks/useKeyframeSync';
import { useLocationTracker } from '../../hooks/useLocationTracker';
import { useSocketSOS } from '../../hooks/useSocketSOS';
import ChatPanel from '../Chat/ChatPanel';
import VoiceCall from '../Call/VoiceCall';
import { useVoiceCall } from '../../hooks/useVoiceCall';

export default function AppLayout() {
  const { user, token } = useAuth();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  
  // Start syncing keyframes in the background
  useKeyframeSync();
  // Start tracking location for monitored users (elderly/normal_user)
  useLocationTracker();
  // Listen for SOS events (for caregivers)
  const { socket, activeSOS, setActiveSOS } = useSocketSOS();
  
  // D FE-4: two-way voice. Mounted at the layout so a call can arrive on any
  // screen, which is the point of it in an emergency.
  const call = useVoiceCall(socket, user?._id);

  // State for manually opened chats
  const [activeChat, setActiveChat] = useState(null);

  if (!token) return <Navigate to="/login" replace />;

  const chatProps = activeSOS || activeChat;

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

      <main className="main-content" style={{ display: 'flex', flexDirection: 'row' }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <Outlet context={{ 
            socket, 
            openChat: (userId, userName) => setActiveChat({ userId, userName, isEmergency: false }),
            openEmergencyChat: (userId, userName) => setActiveChat({ userId, userName, isEmergency: true })
          }} />
        </div>
        
        {chatProps && (
          <div style={{ width: 350, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel 
              socket={socket}
              recipientId={chatProps.userId}
              recipientName={chatProps.userName}
              isEmergency={chatProps.isEmergency}
              // Text and voice are the same conversation; calling from here
              // means the caregiver does not have to find the person again.
              onCall={() => call.call(chatProps.userId, chatProps.userName,
                                      !!chatProps.isEmergency)}
              callState={call.state}
              onClose={() => {
                if (activeSOS) setActiveSOS(null);
                if (activeChat) setActiveChat(null);
              }}
            />
          </div>
        )}
      </main>

      <VoiceCall call={call} />
    </div>
  );
}
