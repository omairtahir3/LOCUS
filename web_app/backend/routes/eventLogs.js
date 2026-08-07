const express = require('express');
const router = express.Router();
const EventLog = require('../models/EventLog');
const { protect: auth } = require('../middleware/auth');

// GET /api/event-logs/memory-search
// Only returns medication_intake and social_interaction, excluding rejected
router.get('/memory-search', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    // If caregiver, they view logs for their connected elderly user
    if (req.user.role === 'caregiver') {
      const User = require('../models/User');
      const caregiver = await User.findById(req.user.id);
      if (caregiver.connected_elderly_user) {
        userId = caregiver.connected_elderly_user;
      }
    }

    const { type, limit = 50 } = req.query;

    const query = {
      user_id: userId,
      event_type: { $in: ['medication_intake', 'social_interaction'] },
      verification_status: { $ne: 'rejected' }
    };

    if (type && query.event_type.$in.includes(type)) {
      query.event_type = type; // override with specific filter
    }

    const events = await EventLog.find(query)
      .populate('person_id', 'person_name relationship_type face_embedding')
      .sort({ timestamp: -1 })
      .limit(Number(limit));

    res.json(events);
  } catch (error) {
    console.error('Error fetching memory search logs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/event-logs/keyframes
// For Keyframe Audit screen (includes unknown_face and medication_intake)
router.get('/keyframes', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      const User = require('../models/User');
      const caregiver = await User.findById(req.user.id);
      if (caregiver.connected_elderly_user) {
        userId = caregiver.connected_elderly_user;
      }
    }

    const { type, limit = 50 } = req.query;

    const query = {
      user_id: userId,
      event_type: { $in: ['medication_intake', 'unknown_face'] },
      verification_status: { $ne: 'rejected' }
    };

    if (type && query.event_type.$in.includes(type)) {
      query.event_type = type;
    }

    const events = await EventLog.find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit));

    res.json(events);
  } catch (error) {
    console.error('Error fetching keyframe logs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
