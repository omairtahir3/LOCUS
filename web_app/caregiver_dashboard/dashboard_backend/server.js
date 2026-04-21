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

const app = express();

// Connect to MongoDB
connectDB();

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
app.listen(PORT, () => console.log(`Dashboard backend running on http://localhost:${PORT}`));