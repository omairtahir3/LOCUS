const express = require('express');
const router = express.Router();
const EventLog = require('../models/EventLog');
const Relationship = require('../models/Relationship');
const User = require('../models/User');
const { protect: auth } = require('../middleware/auth');

// GET /api/relationships
router.get('/', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      const caregiver = await User.findById(req.user.id);
      if (caregiver.monitoring_users && caregiver.monitoring_users.length > 0) {
        userId = caregiver.monitoring_users[0];
      }
    }
    const relationships = await Relationship.find({ user_id: userId }).sort({ createdAt: -1 });
    res.json(relationships);
  } catch (error) {
    console.error('Error fetching relationships:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * What happens to the conversation when an unknown face is finally named.
 *
 * A face nobody has named has, by definition, never been seen before, so the
 * conversation captured alongside it is that person's FIRST interaction and the
 * only record of what was said the first time they appeared. Naming them keeps
 * it: the event becomes a social_interaction belonging to the new relationship,
 * and the relationship records that this is where it started.
 *
 * The transcript still expires on the keyframe clock. The summary does not,
 * because the summary IS the memory of the conversation; the verbatim words are
 * only how it was obtained.
 */
async function keepFirstConversation(event, relationship) {
  const convo = event.details?.conversation;
  if (!convo?.summary && !convo?.transcript) return;
  relationship.first_interaction = {
    event_id: event._id,
    at: event.timestamp,
    summary: convo.summary || null,
    topics: convo.topics || null,
  };
  await relationship.save();
}

/**
 * ...and what happens when they are dismissed instead.
 *
 * Dismissing a face says it should never have been recorded, so nothing of the
 * conversation survives it: not the summary, not the transcript on the event,
 * and not the transcripts row the text was written to. The event itself stays,
 * marked rejected, because the audit trail of what the camera did is separate
 * from the content it captured.
 */
async function discardConversation(event) {
  const convo = event.details?.conversation;
  if (!convo) return;
  if (convo.transcript_id) {
    try {
      const mongoose = require('mongoose');
      await mongoose.connection.db.collection('transcripts')
        .deleteOne({ _id: new mongoose.Types.ObjectId(String(convo.transcript_id)) });
    } catch (e) {
      // A transcript that has already expired is gone, which is the same
      // outcome. Never fail the dismissal over it.
      console.warn('[relationships] transcript already gone:', e.message);
    }
  }
  await EventLog.updateOne({ _id: event._id },
    { $unset: { 'details.conversation': '' } });
}

// POST /api/relationships/confirm
router.post('/confirm', auth, async (req, res) => {
  try {
    let { eventId, personName, relationshipType, force_new, merge_into } = req.body;
    personName = personName ? personName.trim() : '';
    relationshipType = relationshipType ? relationshipType.trim() : '';
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
      if (caregiver.monitoring_users && caregiver.monitoring_users.length > 0) {
        userId = caregiver.monitoring_users[0];
      }
    }

    if (merge_into) {
      const rel = await Relationship.findById(merge_into);
      if (rel) {
        rel.face_embeddings.push(faceEmbedding);
        await rel.save();

        event.event_type = 'social_interaction';
        event.verification_status = 'confirmed';
        event.person_id = rel._id;
        await event.save();
        await keepFirstConversation(event, rel);

        return res.json({ message: 'Merged with existing face', relationship: rel, event });
      }
    } else if (!force_new) {
      const duplicates = await Relationship.find({
        user_id: userId,
        person_name: { $regex: new RegExp(`^${personName}$`, 'i') }
      });
      
      if (duplicates.length > 0) {
        return res.status(409).json({
          error: 'Duplicate name found',
          duplicates: duplicates.map(d => ({
            id: d._id,
            name: d.person_name,
            relationship_type: d.relationship_type,
            confirmed_by: d.confirmed_by,
            createdAt: d.createdAt
          }))
        });
      }
    }

    // Create Relationship
    const relationship = new Relationship({
      user_id: userId,
      person_name: personName,
      relationship_type: relationshipType || '',
      face_embedding: faceEmbedding,
      face_embeddings: [],
      confirmed_by: req.user.role,
      pending_notification: req.user.role === 'caregiver' // Alert elderly user that caregiver acted
    });
    await relationship.save();

    // Update EventLog
    event.event_type = 'social_interaction';
    event.verification_status = 'confirmed';
    event.person_id = relationship._id;
    await event.save();
    // The conversation heard when nobody knew who this was becomes the first
    // thing this relationship remembers.
    await keepFirstConversation(event, relationship);

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
    // Dismissing the face discards what was said with it: the summary, the
    // transcript on the event, and the transcripts row behind it.
    await discardConversation(event);

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

// GET /api/relationships/:id/interactions
router.get('/:id/interactions', auth, async (req, res) => {
  try {
    // Whose person is this? The id came from the URL and nothing checked it, so
    // any signed-in account could read anyone's social history by id. That
    // mattered less while the page was reachable only by caregivers; it is now
    // reachable by every role, and who somebody has been seeing is exactly the
    // kind of thing this app must not hand to a stranger.
    const relationship = await Relationship.findById(req.params.id);
    if (!relationship) return res.status(404).json({ error: 'Not found' });

    const allowed = [String(req.user.id)];
    if (req.user.role === 'caregiver') {
      const caregiver = await User.findById(req.user.id).select('monitoring_users').lean();
      for (const u of (caregiver?.monitoring_users || [])) allowed.push(String(u));
    }
    if (!allowed.includes(String(relationship.user_id))) {
      // 404 rather than 403: whether a given id exists is itself not their business.
      return res.status(404).json({ error: 'Not found' });
    }

    const interactions = await EventLog.find({
      person_id: req.params.id,
      event_type: 'social_interaction'
    }).sort({ timestamp: -1 });

    res.json({ relationship, interactions });
  } catch (error) {
    console.error('Error fetching interactions:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/relationships/merge
router.post('/merge', auth, async (req, res) => {
  try {
    const { sourceId, targetId } = req.body;
    
    const source = await Relationship.findById(sourceId);
    const target = await Relationship.findById(targetId);

    if (!source || !target) {
      return res.status(404).json({ error: 'One or both relationships not found' });
    }

    // Move source base embedding into target's face_embeddings
    if (source.face_embedding && source.face_embedding.length > 0) {
      target.face_embeddings.push(source.face_embedding);
    }
    // Move any additional embeddings from source to target
    if (source.face_embeddings && source.face_embeddings.length > 0) {
      target.face_embeddings.push(...source.face_embeddings);
    }

    await target.save();

    // Reassign all EventLogs
    await EventLog.updateMany(
      { person_id: sourceId },
      { $set: { person_id: targetId } }
    );

    // Delete the source relationship
    await Relationship.findByIdAndDelete(sourceId);

    res.json({ message: 'Relationships merged successfully', relationship: target });
  } catch (error) {
    console.error('Error merging relationships:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
