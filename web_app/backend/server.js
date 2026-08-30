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

const app = express();

// Connect to MongoDB
connectDB();

// Start notification and escalation scheduler
const notificationScheduler = require('./utils/notificationScheduler');
notificationScheduler.init();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/api/auth',          authRoutes);
app.use('/api/medications',   medicationRoutes);
app.use('/api/caregiver',     caregiverRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/detection',     detectionRoutes);
app.use('/api/event-logs',    eventLogRoutes);
app.use('/api/relationships', relationshipRoutes);
app.use('/api/location',      locationRoutes);

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Dashboard backend running on http://0.0.0.0:${PORT}`));