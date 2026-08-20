const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const LocationLog = require('../models/LocationLog');
const User = require('../models/User');

// POST /api/location
// Receives GPS coordinates from the mobile app
router.post('/', auth.protect, async (req, res) => {
  try {
    const { lat, lng, accuracy, speed, timestamp } = req.body;
    
    if (lat == null || lng == null) {
      return res.status(400).json({ msg: 'lat and lng are required' });
    }

    const log = new LocationLog({
      user_id: req.user.id,
      lat,
      lng,
      accuracy: accuracy || 0,
      speed: speed || 0,
      timestamp: timestamp ? new Date(timestamp) : Date.now()
    });

    await log.save();
    
    // Check if user is in 'lost' mode and notify caregivers?
    // We will handle 'lost' mode via sockets when triggered, but we can emit a live update if needed.
    const io = req.app.get('io');
    if (io) {
      io.to(`caregiver_${req.user.id}`).emit('LOCATION_UPDATE', {
        user_id: req.user.id,
        lat,
        lng,
        timestamp: log.timestamp
      });
    }

    res.json(log);
  } catch (err) {
    console.error('Error saving location:', err.message);
    res.status(500).send('Server Error');
  }
});

// GET /api/location/latest
// Returns the most recent location for the authenticated user, or a monitored user
router.get('/latest', auth.protect, async (req, res) => {
  try {
    const targetUserId = req.query.user_id || req.user.id;
    
    // If requesting for another user, ensure they are monitored by the caregiver
    if (targetUserId !== req.user.id) {
      const caregiver = await User.findById(req.user.id);
      if (!caregiver.monitoring_users.includes(targetUserId)) {
        return res.status(403).json({ msg: 'Not authorized to view this user\'s location' });
      }
    }

    const log = await LocationLog.findOne({ user_id: targetUserId }).sort({ timestamp: -1 });
    if (!log) {
      return res.status(404).json({ msg: 'No location data found' });
    }

    res.json(log);
  } catch (err) {
    console.error('Error fetching location:', err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
