import { useState } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import TopDock from '../Nav/TopDock';
import BottomTabs from '../Nav/BottomTabs';
import { useKeyframeSync } from '../../hooks/useKeyframeSync';
import { useSocketSOS } from '../../hooks/useSocketSOS';
import ChatPanel from '../Chat/ChatPanel';
import VoiceCall from '../Call/VoiceCall';
import { useVoiceCall } from '../../hooks/useVoiceCall';
import { ToastProvider } from '../Feedback/Toast';

export default function AppLayout() {
  const { user, token } = useAuth();

  // Start syncing keyframes in the background
  useKeyframeSync();
  // The browser does NOT broadcast location. Position comes from the phone and
  // only from the phone: mobile_app/lib/services/location_service.dart holds a
  // geolocator stream with a 10 m distanceFilter and POSTs each fix to the same
  // /api/location route, which is the wearable's real whereabouts rather than
  // wherever a dashboard happens to be open. Calling useLocationTracker() here
  // made every logged-in wearer's browser raise a permission prompt and then
  // write fixes for a laptop sitting at home, competing with the phone for the
  // newest row in location_logs. The hook is kept in hooks/ but unused.
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
    <ToastProvider>
      {/* No sidebar and no side panel: the dock floats over the content and
          the content owns the full width. Both navigations are always
          mounted; CSS decides which one is on screen, so there is no
          viewport-width state in React to get out of step with the layout. */}
      <div className="app-shell">
        <TopDock socket={socket} />
        <BottomTabs />

        <main className="main-content">
          <div className="page-container">
            <Outlet context={{
              socket,
              openChat: (userId, userName) => setActiveChat({ userId, userName, isEmergency: false }),
              openEmergencyChat: (userId, userName) => setActiveChat({ userId, userName, isEmergency: true })
            }} />
          </div>
        </main>

        {/* The chat was a full-height column welded to the layout grid, which
            is exactly the side panel this redesign removes. It is now an
            overlay: it covers content while a conversation is open and gives
            every pixel back when it closes. */}
        {chatProps && (
          <div className="chat-overlay" role="dialog" aria-label={`Conversation with ${chatProps.userName}`}>
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

        <VoiceCall call={call} />
      </div>
    </ToastProvider>
  );
}
