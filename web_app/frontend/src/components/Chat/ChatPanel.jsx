import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSelectedUser } from '../../context/SelectedUserContext';
import { authAPI } from '../../services/api';
import { Send, X, AlertCircle, MessageCircle } from 'lucide-react';
import { formatClockTime } from '../../utils/dateUtils';

const ChatPanel = ({ socket, recipientId, recipientName, isEmergency, onClose }) => {
  const { user } = useAuth();
  const selectedUserContext = useSelectedUser();
  const globalSelectedUser = selectedUserContext?.selectedUser;

  const activeRecipientId = isEmergency ? recipientId : (recipientId || globalSelectedUser?._id);
  const activeRecipientName = isEmergency ? recipientName : (recipientName || globalSelectedUser?.name || 'Caregiver');

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const fetchHistory = async () => {
      if (!activeRecipientId) return;
      setLoading(true);
      try {
        const res = await authAPI.getChatHistory(activeRecipientId);
        setMessages(res.data);
      } catch (error) {
        console.error('Error fetching chat history:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();

    if (!socket) return;
    const handleNewMessage = (msg) => {
      // Cast both to strings to ensure Mongoose ObjectIds match properly
      if (String(msg.sender_id) === String(activeRecipientId) || String(msg.recipient_id) === String(activeRecipientId)) {
        setMessages((prev) => [...prev, msg]);
      }
    };
    socket.on('chat_message', handleNewMessage);

    return () => {
      socket.off('chat_message', handleNewMessage);
    };
  }, [activeRecipientId, socket]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!inputText.trim() || !socket || !activeRecipientId) return;
    
    // Optimistic UI update so the sender sees their message instantly
    const optimisticMsg = {
      _id: Date.now().toString(),
      sender_id: user._id,
      recipient_id: activeRecipientId,
      text: inputText.trim(),
      timestamp: new Date().toISOString(),
      is_emergency_related: isEmergency
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    
    socket.emit('chat_message', {
      recipient_id: activeRecipientId,
      text: inputText.trim(),
      is_emergency_related: isEmergency
    });
    
    setInputText('');
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') handleSend();
  };

  const formatTime = (isoString) => {
    if (!isoString) return '';
    const d = new Date(isoString);
    return formatClockTime(d);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#F8FAFC', borderLeft: '1px solid #E2E8F0' }}>
      
      {/* Header */}
      <div style={{ padding: '16px 20px', backgroundColor: '#FFFFFF', borderBottom: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', zIndex: 10 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: '#1E293B' }}>{activeRecipientName}</h3>
          {isEmergency && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
              <AlertCircle size={14} color="#EF4444" />
              <span style={{ fontSize: '11px', fontWeight: '800', color: '#EF4444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Emergency Active</span>
            </div>
          )}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px', color: '#94A3B8', borderRadius: '50%', transition: 'background-color 0.2s' }} onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#F1F5F9'} onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
          <X size={20} />
        </button>
      </div>

      {/* Messages Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <div style={{ width: '32px', height: '32px', border: '3px solid #E0E7FF', borderTopColor: '#0D9488', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
          </div>
        ) : messages.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94A3B8' }}>
            <MessageCircle size={48} style={{ marginBottom: '16px', opacity: 0.5 }} />
            <p style={{ margin: 0, fontWeight: '600', color: '#64748B' }}>No messages yet.</p>
            <p style={{ margin: '4px 0 0', fontSize: '12px' }}>Start the conversation below.</p>
          </div>
        ) : (
          messages.map((msg, idx) => {
            // Support both optimistic string IDs and mongoose object IDs
            const isMe = String(msg.sender_id) === String(user._id);
            return (
              <div key={idx} style={{ display: 'flex', justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '75%',
                  padding: '12px 16px',
                  backgroundColor: isMe ? '#0D9488' : '#FFFFFF',
                  color: isMe ? '#FFFFFF' : '#1E293B',
                  borderRadius: '16px',
                  borderTopRightRadius: isMe ? '4px' : '16px',
                  borderTopLeftRadius: isMe ? '16px' : '4px',
                  boxShadow: isMe ? '0 4px 6px -1px rgba(13, 148, 136, 0.2)' : '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
                  border: isMe ? 'none' : '1px solid #E2E8F0',
                }}>
                  <p style={{ margin: 0, fontSize: '14px', lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>{msg.text}</p>
                  <div style={{ fontSize: '10px', marginTop: '6px', textAlign: 'right', color: isMe ? 'rgba(255,255,255,0.7)' : '#94A3B8' }}>
                    {formatTime(msg.timestamp)}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div style={{ padding: '16px', backgroundColor: '#FFFFFF', borderTop: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Type a message..."
          style={{
            flex: 1,
            backgroundColor: '#F1F5F9',
            border: '1px solid transparent',
            borderRadius: '9999px',
            padding: '12px 20px',
            fontSize: '14px',
            outline: 'none',
            transition: 'all 0.2s',
          }}
          onFocus={(e) => { e.target.style.backgroundColor = '#FFFFFF'; e.target.style.borderColor = '#0D9488'; e.target.style.boxShadow = '0 0 0 3px rgba(13, 148, 136, 0.1)'; }}
          onBlur={(e) => { e.target.style.backgroundColor = '#F1F5F9'; e.target.style.borderColor = 'transparent'; e.target.style.boxShadow = 'none'; }}
        />
        <button 
          onClick={handleSend}
          disabled={!inputText.trim()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            backgroundColor: inputText.trim() ? '#0D9488' : '#E2E8F0',
            color: '#FFFFFF',
            border: 'none',
            cursor: inputText.trim() ? 'pointer' : 'not-allowed',
            transition: 'background-color 0.2s',
          }}
        >
          <Send size={18} style={{ transform: 'translateX(-1px) translateY(1px)' }} />
        </button>
      </div>
    </div>
  );
};

export default ChatPanel;
