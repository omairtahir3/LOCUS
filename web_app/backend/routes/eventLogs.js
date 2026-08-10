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
// PATCH /api/event-logs/:id/flag
// Universal endpoint to toggle the is_flagged state of any event (e.g. medication or social)
router.patch('/:id/flag', auth, async (req, res) => {
  try {
    const { is_flagged } = req.body;
    
    if (typeof is_flagged !== 'boolean') {
      return res.status(400).json({ error: 'is_flagged boolean is required' });
    }

    const eventId = req.params.id;
    const event = await EventLog.findById(eventId);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Role check: caregiver can only flag events for their connected user
    if (req.user.role === 'caregiver') {
      const User = require('../models/User');
      const caregiver = await User.findById(req.user.id);
      if (String(event.user_id) !== String(caregiver.connected_elderly_user)) {
        return res.status(403).json({ error: 'Unauthorized to flag this event' });
      }
    } else {
      if (String(event.user_id) !== String(req.user.id)) {
        return res.status(403).json({ error: 'Unauthorized to flag this event' });
      }
    }

    event.is_flagged = is_flagged;
    await event.save();

    res.json(event);
  } catch (error) {
    console.error('Error toggling flag:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
