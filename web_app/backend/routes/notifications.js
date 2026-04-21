const express = require('express');
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');
const User = require('../models/User');

const router = express.Router();

// ─── Internal endpoints (no auth required, called by Python AI pipeline) ─────

// POST /api/notifications/skip  — create a skip notification
router.post('/skip', async (req, res) => {
  try {
    const {
      user_id,
      scheduled_time,
      expected_count,
      taken_count,
      skipped_count,
      detection_events = []
    } = req.body;

    // Resolve the user — use provided user_id or find default
    let recipientId = user_id;
    if (!recipientId) {
      const defaultUser = await User.findOne({ role: { $ne: 'caregiver' } });
      if (defaultUser) recipientId = defaultUser._id;
    }

    if (!recipientId) {
      return res.status(400).json({ error: 'No user_id provided and no default user found' });
    }

    const title = `⚠ Skipped ${skipped_count} Medicine${skipped_count > 1 ? 's' : ''}`;
    const message = `Expected to take ${expected_count} medicine${expected_count > 1 ? 's' : ''} ` +
      `but only ${taken_count} ${taken_count === 1 ? 'was' : 'were'} detected. ` +
      `${skipped_count} medicine${skipped_count > 1 ? 's were' : ' was'} skipped.`;

    const notification = await Notification.create({
      recipient_id: recipientId,
      subject_user_id: recipientId,
      type: 'skipped_medicine',
      title,
      message,
      requires_acknowledgement: true,
    });

    console.log(`[Notifications] Skip notification created: ${title}`);
    res.status(201).json(notification);
  } catch (err) {
    console.error('[Notifications] Error creating skip notification:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Protected endpoints (require user authentication) ───────────────────────
router.use(protect);
// GET /api/notifications  — get all notifications for current user
router.get('/', async (req, res) => {
  try {
    const { unread_only, limit = 30 } = req.query;
    const query = { recipient_id: req.user._id, is_dismissed: { $ne: true } };
    if (unread_only === 'true') query.is_read = false;

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    const unread_count = await Notification.countDocuments({ recipient_id: req.user._id, is_read: false, is_dismissed: { $ne: true } });
    res.json({ notifications, unread_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/notifications/:id/read  — mark as read
router.patch('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { is_read: true, read_at: new Date() },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json(notification);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/notifications/read-all  — mark all as read
router.patch('/read-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient_id: req.user._id, is_read: false },
      { is_read: true, read_at: new Date() }
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/notifications/:id/acknowledge  — acknowledge an alert
router.patch('/:id/acknowledge', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { acknowledged_at: new Date(), is_read: true, read_at: new Date() },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json(notification);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/notifications/:id  — dismiss
router.delete('/:id', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient_id: req.user._id },
      { is_dismissed: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json({ message: 'Notification dismissed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;