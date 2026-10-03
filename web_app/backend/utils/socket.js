const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { createNotification } = require('./notifications');

let io;

/**
 * Whether these two may open a voice channel.
 *
 * Only a caregiver and someone they monitor, in either direction. The check is
 * the same relationship the rest of the system authorises on, and it matters
 * more here than for a message: a call opens a live microphone in somebody's
 * house, so an unlinked pair is refused rather than merely unanswered.
 */
async function canSpeakTo(user, otherId) {
  const other = String(otherId);
  if (String(user._id) === other) return false;
  if (user.role === 'caregiver') {
    return (user.monitoring_users || []).some(id => String(id) === other);
  }
  if ((user.caregiver_ids || []).some(id => String(id) === other)) return true;
  // caregiver_ids is not always populated on the elderly side, so the link is
  // confirmed from the caregiver's own record before refusing.
  const caregiver = await User.findById(other).select('role monitoring_users');
  return !!caregiver && caregiver.role === 'caregiver'
    && (caregiver.monitoring_users || []).some(id => String(id) === String(user._id));
}

/** Tell anyone linked to this user that their connection went away. */
async function notifyPeersOfDrop(socket) {
  const u = socket.user;
  const peers = u.role === 'caregiver' ? (u.monitoring_users || []) : (u.caregiver_ids || []);
  for (const id of peers) {
    io.to(String(id)).emit('call:ended', { from: String(u._id), reason: 'disconnected' });
  }
}

module.exports = {
  init: (httpServer) => {
    io = socketIO(httpServer, {
      cors: {
        origin: '*', // Adjust in production
        methods: ['GET', 'POST']
      }
    });

    // Authentication Middleware
    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error('Authentication error: No token provided'));

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.sub).select('-password');
        
        if (!user) return next(new Error('Authentication error: User not found'));

        socket.user = user;
        next();
      } catch (err) {
        next(new Error('Authentication error: Invalid token'));
      }
    });

    io.on('connection', (socket) => {
      console.log(`[Socket] Client connected: ${socket.id}, User: ${socket.user._id}`);
      
      // Auto-join the socket to a room identical to their secure user ID
      socket.join(socket.user._id.toString());
      console.log(`[Socket] Auto-joined room: ${socket.user._id}`);

      // Chat implementation
      socket.on('chat_message', async (data) => {
        try {
          const Message = require('../models/Message');
          const { recipient_id, text, is_emergency_related } = data;
          
          if (!recipient_id || !text) return;

          // Save to database
          const message = new Message({
            sender_id: socket.user._id,
            recipient_id,
            text,
            is_emergency_related: !!is_emergency_related
          });
          await message.save();

          // Broadcast to recipient
          io.to(recipient_id.toString()).emit('chat_message', message);
          
          // Send back to sender for confirmation
          socket.emit('chat_message', message);
          
          // Dispatch notification to recipient
          if (socket.user.role === 'elderly') {
            await createNotification({
              recipientId: recipient_id,
              subjectUserId: socket.user._id,
              type: is_emergency_related ? 'escalated' : 'caregiver_message',
              title: is_emergency_related 
                ? `URGENT MESSAGE from ${socket.user.name}` 
                : `New Message from ${socket.user.name}`,
              message: text,
              requiresAck: is_emergency_related,
              sender: socket.user.name
            });
          }
        } catch (error) {
          console.error('[Socket] Chat error:', error);
        }
      });

      // ── D FE-4: two-way voice ────────────────────────────────────────
      //
      // The call itself is peer to peer; the server only introduces the two
      // ends. That is the whole reason this costs so little: Socket.IO is
      // already authenticated by JWT and every client is already in a room
      // named by their user id, so relaying an offer is one emit. No media
      // ever passes through here, which is also why a voice call does not put
      // the backend on the critical path of someone's emergency.
      //
      // ponytail: no WebRTC signalling library and no third-party calling SDK.
      // Signalling is "pass this blob to that user", which this server already
      // does for chat.
      const relay = async (event, outEvent, build) => {
        socket.on(event, async (data = {}) => {
          try {
            const to = String(data.to || '');
            if (!to) return;
            if (!(await canSpeakTo(socket.user, to))) {
              // Not linked. Nothing is relayed and the caller is told, rather
              // than left listening to a ring that will never be answered.
              return socket.emit('call:ended', { from: to, reason: 'not_permitted' });
            }
            io.to(to).emit(outEvent, { from: String(socket.user._id), ...build(data, socket) });
          } catch (err) {
            console.error(`[Socket] ${event} error:`, err.message);
          }
        });
      };

      relay('call:offer', 'call:incoming', (d, sk) => ({
        sdp: d.sdp,
        fromName: sk.user.name,
        fromRole: sk.user.role,
        // Marks a call raised from an active emergency, so the other end can
        // present it as one instead of as an ordinary call.
        sos: !!d.sos,
      }));
      relay('call:answer', 'call:answered', d => ({ sdp: d.sdp }));
      // ICE candidates arrive in a flurry while the connection is negotiated
      // and are worthless once it is up, so they are relayed and not stored.
      relay('call:ice', 'call:ice', d => ({ candidate: d.candidate }));
      relay('call:end', 'call:ended', d => ({ reason: d.reason || 'ended' }));

      socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
        // A dropped connection mid-call leaves the other end listening to
        // silence, so everyone this user could be talking to is told.
        notifyPeersOfDrop(socket).catch(() => {});
      });
    });

    return io;
  },
  getIO: () => {
    if (!io) {
      throw new Error('Socket.io not initialized!');
    }
    return io;
  }
};
