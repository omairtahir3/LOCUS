const express = require('express');
const router = express.Router();
const EventLog = require('../models/EventLog');
const Relationship = require('../models/Relationship');
const User = require('../models/User');
const { protect: auth } = require('../middleware/auth');

// POST /api/relationships/confirm
router.post('/confirm', auth, async (req, res) => {
  try {
    const { eventId, personName, relationshipType } = req.body;
    const event = await EventLog.findById(eventId);

    if (!event || event.event_type !== 'unknown_face') {
      return res.status(404).json({ error: 'Unknown face event not found' });
    }

    // Check two-tier timing rule for caregivers
    if (req.user.role === 'caregiver') {
      const timeSinceEvent = Date.now() - new Date(event.timestamp).getTime();
      const hoursSinceEvent = timeSinceEvent / (1000 * 60 * 60);
      if (hoursSinceEvent < 24) {
        return res.status(403).json({ error: 'Caregivers cannot confirm faces until 24 hours have passed.' });
      }
    }

    // Extract embedding
    const faceEmbedding = event.details?.face_embedding;
    if (!faceEmbedding) {
      return res.status(400).json({ error: 'No face embedding found in event details' });
    }

    // Determine user_id
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      const caregiver = await User.findById(req.user.id);
      userId = caregiver.connected_elderly_user;
    }

    // Create Relationship
    const relationship = new Relationship({
      user_id: userId,
      person_name: personName,
      relationship_type: relationshipType || '',
      face_embedding: faceEmbedding,
      confirmed_by: req.user.role,
      pending_notification: req.user.role === 'caregiver' // Alert elderly user that caregiver acted
    });
    await relationship.save();

    // Update EventLog
    event.event_type = 'social_interaction';
    event.verification_status = 'confirmed';
    event.person_id = relationship._id;
    await event.save();

    res.json({ message: 'Face confirmed', relationship, event });
  } catch (error) {
    console.error('Error confirming face:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/relationships/dismiss
router.post('/dismiss', auth, async (req, res) => {
  try {
    const { eventId } = req.body;
    const event = await EventLog.findById(eventId);

    if (!event || event.event_type !== 'unknown_face') {
      return res.status(404).json({ error: 'Unknown face event not found' });
    }

    // Check two-tier timing rule for caregivers
    if (req.user.role === 'caregiver') {
      const timeSinceEvent = Date.now() - new Date(event.timestamp).getTime();
      const hoursSinceEvent = timeSinceEvent / (1000 * 60 * 60);
      if (hoursSinceEvent < 24) {
        return res.status(403).json({ error: 'Caregivers cannot dismiss faces until 24 hours have passed.' });
      }
    }

    // Update EventLog
    event.verification_status = 'rejected';
    event.pending_notification = req.user.role === 'caregiver'; // Alert elderly user
    await event.save();

    res.json({ message: 'Face dismissed', event });
  } catch (error) {
    console.error('Error dismissing face:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/relationships/acknowledge
router.post('/acknowledge', auth, async (req, res) => {
  try {
    const { eventId, relationshipId } = req.body;

    if (eventId) {
      const event = await EventLog.findById(eventId);
      if (event) {
        event.pending_notification = false;
        await event.save();
      }
    }

    if (relationshipId) {
      const relationship = await Relationship.findById(relationshipId);
      if (relationship) {
        relationship.pending_notification = false;
        await relationship.save();
      }
    }

    res.json({ message: 'Acknowledged' });
  } catch (error) {
    console.error('Error acknowledging action:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
