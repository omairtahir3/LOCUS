const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

const generateToken = (userId, role) =>
  jwt.sign({ sub: userId, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });


// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email, and password are required' });

    const existing = await User.findOne({ email });
    if (existing)
      return res.status(400).json({ error: 'Email already registered' });

    const user = await User.create({ name, email, password, role: role || 'user' });
    const token = generateToken(user._id, user.role);

    res.status(201).json({ user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid email or password' });

    const token = generateToken(user._id, user.role);
    res.json({ user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ user: req.user });
});


// POST /api/auth/link-caregiver  — user links a caregiver to their account
router.post('/link-caregiver', protect, async (req, res) => {
  try {
    const { caregiver_email } = req.body;

    const caregiver = await User.findOne({ email: caregiver_email, role: 'caregiver' });
    if (!caregiver)
      return res.status(404).json({ error: 'Caregiver not found with that email' });

    // Add caregiver to user's list
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { caregiver_ids: caregiver._id }
    });

    // Add user to caregiver's monitoring list
    await User.findByIdAndUpdate(caregiver._id, {
      $addToSet: { monitoring_users: req.user._id }
    });

    res.json({ message: `${caregiver.name} linked as your caregiver` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;