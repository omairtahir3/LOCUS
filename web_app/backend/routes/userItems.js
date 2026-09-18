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
    try {
      const aiRes = await axios.post(
        `${AI_BACKEND_URL}/api/detection/extract-embedding`,
        { frames },
        { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
      );
      embeddings = aiRes.data.embeddings;
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
      representative_image: representativeImage,
      enrolled_by: req.user.role === 'caregiver' ? 'caregiver' : (req.user.role || 'user'),
      is_active: true
    });

    console.log(`[UserItems] Enrolled "${item_name}" for user ${userId} with ${embeddings.length} embeddings (${embeddings[0]?.length || 0}-D)`);
    res.status(201).json(item);
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
    const items = await UserItem.find({ user_id: userId, is_active: true })
      .select('-item_embeddings')  // Don't send large embedding arrays to the client
      .sort({ createdAt: -1 });
    res.json(items);
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
