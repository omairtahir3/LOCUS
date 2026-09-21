require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/db');

// Route imports
const authRoutes         = require('./routes/auth');
const medicationRoutes   = require('./routes/medication');
const caregiverRoutes    = require('./routes/caregiver');
const notificationRoutes = require('./routes/notifications');
const detectionRoutes    = require('./routes/detection');
const eventLogRoutes     = require('./routes/eventLogs');
const relationshipRoutes = require('./routes/relationships');
const locationRoutes     = require('./routes/location');
const userRoutes         = require('./routes/users');
const userItemRoutes     = require('./routes/userItems');

const app = express();

// Connect to MongoDB
connectDB();

// Start notification and escalation scheduler
const notificationScheduler = require('./utils/notificationScheduler');
notificationScheduler.init();

const eventLogRetention = require('./utils/eventLogRetention');
eventLogRetention.init();

// Middleware
app.use(cors());
// Item enrolment posts 3-5 base64 photos in one body; phone-camera frames run
// several MB each, well past the 100kb default, which rejected the request
// before the route ran and surfaced as a generic 500.
app.use(express.json({ limit: '25mb' }));
app.use(morgan('dev'));

// Routes
app.use('/api/auth',          authRoutes);
app.use('/api/medications',   medicationRoutes);
app.use('/api/caregiver',     caregiverRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/detection',     detectionRoutes);
app.use('/api/event-logs',    eventLogRoutes);
app.use('/api/relationships', relationshipRoutes);
app.use('/api/user-items',    userItemRoutes);
app.use('/api/location',      locationRoutes);
app.use('/api/users',         userRoutes);

// Health check
app.get('/', (req, res) => res.json({
  app: 'MemoryAssist Dashboard API',
  version: '1.0.0',
  status: 'running',
  services: {
    dashboard_backend: 'Node + Express (this service)',
    ai_backend:        'Python + FastAPI — http://localhost:8000',
    database:          'MongoDB'
  }
}));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

const http = require('http');
const server = http.createServer(app);

// Initialize Socket.io
const socketUtils = require('./utils/socket');
socketUtils.init(server);

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Dashboard backend running on http://0.0.0.0:${PORT}`));