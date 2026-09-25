const express = require('express');
const router = express.Router();
const UserItem = require('../models/UserItem');
const User = require('../models/User');
const { protect: auth } = require('../middleware/auth');
const axios = require('axios');

// AI Backend URL for embedding extraction
const AI_BACKEND_URL = process.env.AI_BACKEND_URL || 'http://localhost:8000';

/**
 * Resolve the target user ID for item operations.
 * Caregivers operate on behalf of their monitored elderly user.
 */
// The cosine similarity the AI backend's matcher demands before it will call a
// crop "this person's Phone" (item_indexer.EXEMPLAR_MATCH_THRESHOLD). Kept here
// only to judge whether a gallery could ever clear it.
const MATCH_THRESHOLD = 0.74;

/**
 * How much an item's own enrolment photos agree with each other.
 *
 * This is the difference between an item that works and one that silently never
 * matches anything. Osaid's "Phone" was enrolled from 4 photos whose pairwise
 * similarity ran 0.507 to 0.849, mean 0.699 -- below the 0.74 the matcher
 * requires. The gallery could not match ITSELF at the bar a novel view has to
 * clear, so the phone was never once recognised, and nothing anywhere said so:
 * the item looked perfectly healthy in the UI, with four embeddings and an
 * enrolment photo. Lowering the threshold is not the answer, because the
 * measured false positives sit at 0.663-0.714 (a computer mouse matched
 * "Phone" at 0.663). The answer is to notice at enrolment time and ask for
 * better photos.
 */
// Sources at or above this were LEARNED by the system from its own camera,
// not photographed by the person (item_indexer.LEARNED_SOURCE_BASE). They are
// excluded from the health check: the question that check answers is "are the
// photos you took good enough", and grading the system's own output would
// answer a different one, and would drift as it learned.
const LEARNED_SOURCE_BASE = 1000;

function galleryCoherence(embeddings, sources = []) {
  const vecs = [];
  const src = [];
  const hasMap = Array.isArray(sources) && sources.length === (embeddings || []).length;
  (embeddings || []).forEach((e, i) => {
    if (!Array.isArray(e) || !e.length) return;
    // No mapping means one embedding per photo, as it was before each photo
    // was expanded across lighting and angle.
    const s = hasMap ? sources[i] : i;
    if (typeof s === 'number' && s >= LEARNED_SOURCE_BASE) return;
    vecs.push(e);
    src.push(s);
  });
  if (vecs.length < 2) return null;
  const cos = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };
  // Only across DIFFERENT photos. Variants of one photo are near identical by
  // construction, so including them would report every gallery as healthy
  // however poor the originals were, and the warning would never fire again.
  const sims = [];
  for (let i = 0; i < vecs.length; i++)
    for (let j = i + 1; j < vecs.length; j++)
      if (src[i] !== src[j]) sims.push(cos(vecs[i], vecs[j]));
  if (!sims.length) return null;      // every embedding came from one photo
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const min = Math.min(...sims);
  const photos = new Set(src).size;
  return {
    mean: Number(mean.toFixed(3)),
    min: Number(min.toFixed(3)),
    pairs: sims.length,
    photos,
    variants: vecs.length,
    // Below the matcher's own bar this item cannot reliably be recognised.
    matchable: mean >= MATCH_THRESHOLD,
    threshold: MATCH_THRESHOLD,
  };
}

async function resolveUserId(req) {
  let userId = req.user.id;
  if (req.user.role === 'caregiver') {
    const caregiver = await User.findById(req.user.id);
    if (caregiver.monitoring_users && caregiver.monitoring_users.length > 0) {
      userId = caregiver.monitoring_users[0];
    }
  }
  return userId;
}

// POST /api/user-items/enroll
// Enroll a new personal item with 3-5 photos from different angles
router.post('/enroll', auth, async (req, res) => {
  try {
    const { item_name, frames } = req.body;

    if (!item_name || !item_name.trim()) {
      return res.status(400).json({ error: 'Item name is required' });
    }
    if (!frames || !Array.isArray(frames) || frames.length < 1) {
      return res.status(400).json({ error: 'At least 1 image frame is required' });
    }
    if (frames.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 frames allowed' });
    }

    const userId = await resolveUserId(req);

    // Forward frames to FastAPI for MobileNetV3-Small embedding extraction
    let embeddings;
    let embeddingSources = [];
    try {
      const aiRes = await axios.post(
        `${AI_BACKEND_URL}/api/detection/extract-embedding`,
        { frames },
        { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
      );
      embeddings = aiRes.data.embeddings;
      embeddingSources = aiRes.data.source_indices || [];
    } catch (aiErr) {
      console.error('[UserItems] AI embedding extraction failed:', aiErr.message);
      return res.status(502).json({ error: 'Failed to extract item embeddings from AI backend' });
    }

    if (!embeddings || embeddings.length === 0) {
      return res.status(422).json({ error: 'Could not extract embeddings from provided images' });
    }

    // Use first frame as representative thumbnail (already base64)
    const representativeImage = frames[0];

    const item = await UserItem.create({
      user_id: userId,
      item_name: item_name.trim(),
      item_embeddings: embeddings,
      embedding_sources: embeddingSources,
      representative_image: representativeImage,
      enrolled_by: req.user.role === 'caregiver' ? 'caregiver' : (req.user.role || 'user'),
      is_active: true
    });

    const coherence = galleryCoherence(embeddings, embeddingSources);
    console.log(`[UserItems] Enrolled "${item_name}" for user ${userId} with ${embeddings.length} embeddings (${embeddings[0]?.length || 0}-D)`);
    if (coherence && !coherence.matchable) {
      console.warn(`[UserItems] "${item_name}" may never be recognised: its own photos `
        + `agree at only ${coherence.mean} (lowest pair ${coherence.min}), below the `
        + `${MATCH_THRESHOLD} the matcher requires. Retake with the item filling the frame, `
        + `same lighting, a few angles.`);
    }
    // Returned so the enrolment screen can say so rather than reporting success
    // on an item that will never match anything.
    res.status(201).json({
      ...item.toObject(),
      item_embeddings: undefined,
      gallery: coherence,
      warning: coherence && !coherence.matchable
        ? `These photos are too different from each other for "${item_name}" to be `
          + `recognised reliably. Retake them with the item filling the frame, in the `
          + `same lighting, from a few angles.`
        : undefined,
    });
  } catch (error) {
    console.error('Error enrolling item:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user-items
// List all enrolled items for the authenticated user
router.get('/', auth, async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    // Embeddings are read but never sent: they are needed to judge whether each
    // gallery can actually be matched, and an item that cannot is worth saying
    // so on the list, not only at the moment it was enrolled.
    const items = await UserItem.find({ user_id: userId, is_active: true })
      .sort({ createdAt: -1 }).lean();
    res.json(items.map(({ item_embeddings, embedding_sources, ...rest }) => ({
      ...rest,
      gallery: galleryCoherence(item_embeddings, embedding_sources),
    })));
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user-items/:id
// Get a single item by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const item = await UserItem.findOne({ _id: req.params.id, user_id: userId })
      .select('-item_embeddings');
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  } catch (error) {
    console.error('Error fetching item:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/user-items/:id
// Update item name
router.put('/:id', auth, async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const { item_name } = req.body;

    const item = await UserItem.findOneAndUpdate(
      { _id: req.params.id, user_id: userId, is_active: true },
      { item_name: item_name.trim() },
      { new: true }
    ).select('-item_embeddings');

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/user-items/:id
// Soft-delete an item (set is_active = false)
// GET /api/user-items/:id/last-seen
// Core FE-13: where and when this item was last sighted, with the frame that
// saw it. Location is the GPS fix attached at sighting time (<=10 min old).
// Also returns the most recent sightings so a map can draw a trail.
router.get('/:id/last-seen', auth, async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const item = await UserItem.findOne({ _id: req.params.id, user_id: userId });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const EventLog = require('../models/EventLog');
    const limit = Math.min(50, Number(req.query.limit) || 10);
    const events = await EventLog.find({
      user_id: { $in: [userId, String(userId)] }, event_type: 'object',
      'details.items.enrolled_item_id': String(item._id),
    }).sort({ timestamp: -1 }).limit(limit).lean();

    const sightings = events.map(ev => {
      const hit = (ev.details?.items || []).find(i => String(i.enrolled_item_id) === String(item._id)) || {};
      return {
        timestamp: ev.timestamp,
        keyframe_id: ev.keyframe_id,
        image_url: ev.keyframe_id ? `/api/detection/keyframes/${ev.keyframe_id}/image` : null,
        location: ev.location || null,           // null when no fresh GPS fix existed at sighting
        similarity: hit.exemplar_similarity ?? null,
        source: hit.generic_name ?? null,        // "tile_scan" or the YOLO class that boxed it
      };
    });
    const lastWithLocation = sightings.find(s => s.location);

    res.json({
      item: { id: item._id, name: item.item_name },
      last_seen: sightings[0] || null,
      last_seen_location: lastWithLocation ? { ...lastWithLocation.location, timestamp: lastWithLocation.timestamp } : null,
      sightings,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const userId = await resolveUserId(req);
    const item = await UserItem.findOneAndUpdate(
      { _id: req.params.id, user_id: userId },
      { is_active: false },
      { new: true }
    );
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json({ message: 'Item removed' });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
