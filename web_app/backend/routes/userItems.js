const express = require('express');

// How many photographs an enrolment needs. See the enrol route for why ten.
const MIN_ENROLL_FRAMES = Number(process.env.MIN_ENROLL_FRAMES || 10);
const MAX_ENROLL_FRAMES = Number(process.env.MAX_ENROLL_FRAMES || 15);
const router = express.Router();
const UserItem = require('../models/UserItem');
const User = require('../models/User');
const { protect: auth } = require('../middleware/auth');
const axios = require('axios');

// AI Backend URL for embedding extraction
const AI_BACKEND_URL = process.env.AI_BACKEND_URL || 'http://127.0.0.1:8000';

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

/**
 * Is this new gallery closer to a belonging the wearer ALREADY has than it is
 * to itself?
 *
 * This is the failure that went unnoticed for weeks. One account's galleries
 * agreed with EACH OTHER at 0.808 (Phone vs Earbuds) and 0.797 (Earbuds vs
 * Keys), while each agreed with ITSELF across its own photos at a mean of
 * 0.647. Three small dark low-texture objects, photographed the same way, are
 * nearer to one another in this embedding space than any of them is to another
 * view of itself -- and once that is true no threshold can separate them, so
 * the matcher either refuses everything or confuses everything.
 *
 * Nothing downstream can fix it, which is why it is said HERE, at the only
 * moment the wearer is holding the item and could take different photographs.
 *
 * Returns {name, cross, self} for the nearest existing item, or null when
 * there is nothing to be confused with.
 */
function nearestOtherItem(embeddings, selfMean, others) {
  let worst = null;
  for (const other of others) {
    const vecs = other.item_embeddings || [];
    if (!vecs.length) continue;
    let top = 0;
    for (const a of embeddings) {
      for (const b of vecs) {
        let d = 0;
        for (let i = 0; i < a.length; i++) d += a[i] * b[i];
        if (d > top) top = d;
      }
    }
    if (!worst || top > worst.cross) {
      worst = { name: other.item_name, cross: Number(top.toFixed(3)), self: selfMean };
    }
  }
  return worst;
}

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
// Enroll a new personal item. See MIN_ENROLL_FRAMES for why ten is the floor.
router.post('/enroll', auth, async (req, res) => {
  try {
    const { item_name, frames } = req.body;

    if (!item_name || !item_name.trim()) {
      return res.status(400).json({ error: 'Item name is required' });
    }
    // Ten is a floor, not a suggestion.
    //
    // One enrolled phone had four photographs. Those four agreed with each
    // other at only 0.699, which is a loose cluster for a 576-D embedding, and
    // the matcher spent the rest of its life trying to fill the gap: it learned
    // 156 exemplars from its own sightings, drifted until they scored 0.567
    // against the real photos, and started claiming anything roughly phone
    // shaped. A gallery this thin cannot recognise an object across a room, and
    // it cannot safely teach itself either.
    //
    // Fifteen is the ceiling only because beyond it the marginal photograph
    // adds little and the enrolment becomes a chore people abandon halfway.
    if (!frames || !Array.isArray(frames) || frames.length < MIN_ENROLL_FRAMES) {
      return res.status(400).json({
        error: `At least ${MIN_ENROLL_FRAMES} images are required`,
        detail: 'Take them from different angles, distances and lighting. '
          + 'Fewer than this and the item cannot be told apart from similar objects.',
        received: Array.isArray(frames) ? frames.length : 0,
        required: MIN_ENROLL_FRAMES,
      });
    }
    if (frames.length > MAX_ENROLL_FRAMES) {
      return res.status(400).json({
        error: `At most ${MAX_ENROLL_FRAMES} images are allowed`,
        received: frames.length,
        allowed: MAX_ENROLL_FRAMES,
      });
    }

    const userId = await resolveUserId(req);

    // Forward frames to FastAPI for MobileNetV3-Small embedding extraction
    let embeddings;
    let embeddingSources = [];
    // What the detector calls this item, measured on its own photos. See
    // UserItem.detector_class.
    let detectorClass = null;
    try {
      const aiRes = await axios.post(
        `${AI_BACKEND_URL}/api/detection/extract-embedding`,
        { frames },
        { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
      );
      embeddings = aiRes.data.embeddings;
      embeddingSources = aiRes.data.source_indices || [];
      detectorClass = aiRes.data.detector_class || null;
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
      detector_class: detectorClass,
      representative_image: representativeImage,
      enrolled_by: req.user.role === 'caregiver' ? 'caregiver' : (req.user.role || 'user'),
      is_active: true
    });

    const coherence = galleryCoherence(embeddings, embeddingSources);

    // Can this be told apart from what the wearer already owns? Read AFTER the
    // insert and filtered by id, so the new item is not compared against
    // itself.
    let confusable = null;
    try {
      const others = await UserItem.find({
        user_id: userId, is_active: true, _id: { $ne: item._id },
      }).select('item_name item_embeddings').lean();
      const near = nearestOtherItem(embeddings, coherence ? coherence.mean : null, others);
      // Nearer to something else than to its own other photos. Below that it
      // is ordinary overlap and not worth a warning.
      if (near && coherence && near.cross >= coherence.mean) confusable = near;
    } catch (e) {
      console.warn('[UserItems] could not compare against existing items:', e.message);
    }

    // Stored, so the list endpoint never has to work it out again.
    await UserItem.updateOne({ _id: item._id },
      { $set: { gallery: { ...(coherence || {}), confusable } } });
    console.log(`[UserItems] Enrolled "${item_name}" for user ${userId} with ${embeddings.length} embeddings (${embeddings[0]?.length || 0}-D)`);
    if (confusable) {
      console.warn(`[UserItems] "${item_name}" looks more like "${confusable.name}" `
        + `(${confusable.cross}) than like its own other photos (${confusable.self}). `
        + `No threshold can separate them, so one will be reported as the other. `
        + `Photograph them apart: different distances, different backgrounds, and `
        + `each filling its own frame.`);
    }
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
      gallery: { ...(coherence || {}), confusable },
      warning: confusable
        ? `"${item_name}" looks more like your "${confusable.name}" than it looks like `
          + `its own other photos, so the camera will mix them up. Photograph them at `
          + `different distances and against different backgrounds, each one filling `
          + `its own frame.`
        : (coherence && !coherence.matchable
          ? `These photos are too different from each other for "${item_name}" to be `
            + `recognised reliably. Retake them with the item filling the frame, in the `
            + `same lighting, from a few angles.`
          : undefined),
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
    // The embeddings are NOT read here. They were, so that each gallery's
    // coherence could be judged and an unmatchable item flagged on the list --
    // but that meant pulling roughly 2 MB of vectors per item out of Mongo and
    // running an O(n^2) cosine over them on every single request. Measured at
    // 530 ms to answer a call whose query takes 21 ms.
    //
    // A gallery only changes when it is enrolled, so its coherence is computed
    // there and stored. Items enrolled before that are filled in lazily below,
    // once each, rather than in a migration nobody would remember to run.
    const items = await UserItem.find({ user_id: userId, is_active: true })
      .select('-item_embeddings -embedding_sources')
      .sort({ createdAt: -1 }).lean();

    const missing = items.filter(i => i.gallery === undefined || i.gallery === null);
    if (missing.length) {
      const full = await UserItem.find({ _id: { $in: missing.map(i => i._id) } })
        .select('item_embeddings embedding_sources').lean();
      for (const f of full) {
        const g = galleryCoherence(f.item_embeddings, f.embedding_sources);
        await UserItem.updateOne({ _id: f._id }, { $set: { gallery: g } });
        const row = items.find(i => String(i._id) === String(f._id));
        if (row) row.gallery = g;
      }
      console.log(`[UserItems] backfilled gallery coherence for ${full.length} item(s)`);
    }
    res.json(items);
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user-items/last-seen?user_id=&hours=
//
// Where each belonging was last seen, with its GPS fix, in ONE call.
//
// FE 10-4 asks for location history "with item last-seen markers". The data was
// already being written -- every object event carries the GPS fix that was
// current when the item was sighted (FE-13) -- and /:id/last-seen could read it
// for one item at a time, which no client ever did because a map needs them all
// at once.
//
// Registered BEFORE /:id deliberately: Express matches in order, so with this
// below it "last-seen" is read as an item id and answers 404.
router.get('/last-seen', auth, async (req, res) => {
  try {
    // Same convention as /api/location/latest: an explicit user_id must be one
    // this caregiver monitors, and a caregiver with none named falls back to
    // their first.
    let userId = req.query.user_id || req.user.id;
    if (String(userId) !== String(req.user.id)) {
      const caregiver = await User.findById(req.user.id);
      const monitored = (caregiver?.monitoring_users || []).map(String);
      if (!monitored.includes(String(userId))) {
        return res.status(403).json({ error: "Not authorized to view these items" });
      }
    } else {
      userId = await resolveUserId(req);
    }

    const EventLog = require('../models/EventLog');
    // A marker older than this is a memory, not a place to go and look. Three
    // days by default, which outlives the 36 h keyframe window so the pin
    // survives the photograph.
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 72));
    const since = new Date(Date.now() - hours * 3600000);

    const items = await UserItem.find({ user_id: userId, is_active: true })
      .select('item_name').lean();
    if (!items.length) return res.json({ items: [] });
    const nameOf = new Map(items.map(i => [String(i._id), i.item_name]));

    // Only sightings that carry a fix: without one there is nothing to pin.
    const events = await EventLog.find({
      user_id: { $in: [userId, String(userId)] },
      event_type: 'object',
      timestamp: { $gte: since },
      'location.lat': { $exists: true },
    }).sort({ timestamp: -1 }).select('timestamp keyframe_id location details.items').lean();

    // Newest wins. Keyed by STRING: an ObjectId key compares by reference, so
    // a Map keyed on the raw value silently keeps every sighting separate.
    const latest = new Map();
    for (const ev of events) {
      for (const it of (ev.details?.items || [])) {
        const id = it.enrolled_item_id && String(it.enrolled_item_id);
        if (!id || !nameOf.has(id) || latest.has(id)) continue;
        latest.set(id, {
          item_id: id,
          name: nameOf.get(id),
          at: ev.timestamp,
          location: ev.location,
          placement: it.placement || null,
          keyframe_id: ev.keyframe_id || null,
          // The route is authorised, so a browser <img> needs ?t= from
          // /api/detection/image-token and Flutter needs the header.
          image_url: ev.keyframe_id
            ? `/api/detection/keyframes/${ev.keyframe_id}/image` : null,
        });
      }
    }

    // Newest first, so the list beside the map reads in the same order.
    const out = [...latest.values()].sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ items: out, window_hours: hours });
  } catch (err) {
    console.error('Error fetching item last-seen:', err);
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
        // No client reads this yet. When one does: that route is authorised now,
        // so a browser <img> needs ?t= from /api/detection/image-token, and a
        // Flutter Image.network needs the Authorization header.
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
