const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { createNotification } = require('./notifications');

let io;

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

      socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
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
