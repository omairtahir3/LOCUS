const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { sendEmail, getLocusEmailHtml, getLocusEmailText } = require('../utils/notifications');
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
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


// POST /api/auth/google — Login or Auto-Register with Google ID Token
router.post('/google', async (req, res) => {
  try {
    const { token, role } = req.body;
    if (!token) return res.status(400).json({ error: 'Google token is required' });

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: [
        process.env.GOOGLE_CLIENT_ID, 
        '454678423894-37c3svs59772gipj48k9qvfqbvfbas3u.apps.googleusercontent.com', // locus web client id
        '244657783963-pgq6940j7ie9ethpto2v5t2470m86clq.apps.googleusercontent.com'  // locus android native client id
      ],
    });
    const { email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ email });

    if (!user) {
      if (!req.body.confirmRole) {
        return res.json({
          requiresRole: true,
          token,
          email,
          name: name || email.split('@')[0],
          picture,
        });
      }

      const randomPassword = require('crypto').randomBytes(16).toString('hex');
      user = await User.create({
        name: name || email.split('@')[0],
        email,
        password: randomPassword,
        role: role || 'caregiver',
        picture: picture || null,
        profile_picture: picture || null,
      });
    } else if (picture && (user.picture !== picture || user.profile_picture !== picture)) {
      user.picture = picture;
      user.profile_picture = picture;
      await user.save();
    }

    const jwtToken = generateToken(user._id, user.role);
    res.json({ user, token: jwtToken });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid Google authentication token: ' + err.message });
  }
});


// GET /api/auth/me
router.get('/me', protect, (req, res) => {
  res.json({ user: req.user });
});


// GET /api/auth/my-caregivers — who watches this account, with names.
//
// /me already returns caregiver_ids, but as bare ObjectIds. A voice call needs
// a name to put on the ringing screen, and someone in an emergency should not
// be looking at an id. Looked up live rather than cached on the client, because
// an account can gain a caregiver after the app started.
router.get('/my-caregivers', protect, async (req, res) => {
  try {
    const me = await User.findById(req.user._id)
      .populate('caregiver_ids', 'name email role');
    res.json(me?.caregiver_ids || []);
  } catch (error) {
    console.error('Error listing caregivers:', error);
    res.status(500).json({ error: 'Server error' });
  }
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

// POST /api/auth/forgot-password — send 15-min JWT reset email
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ message: 'If that email is registered, a password reset link has been sent.' });
    }

    const secret = process.env.JWT_SECRET + user.password;
    const payload = { email: user.email, id: user._id };
    const token = jwt.sign(payload, secret, { expiresIn: '15m' });

    const appUrl = process.env.APP_URL || 'http://localhost:5173';
    const resetUrl = `${appUrl}/reset-password?token=${token}&id=${user._id}`;

    // Same light green shell as every other LOCUS email (utils/notifications.js).
    const parts = {
      type: 'system',
      kicker: 'Password reset',
      title: 'Reset your LOCUS password',
      message: `Someone asked to reset the password for ${user.email}. The link below works for the next 15 minutes and can only be used once.`,
      ctaLabel: 'Choose a new password',
      ctaUrl: resetUrl,
      footNote: "If this wasn't you, you can ignore this email and your password stays as it is.",
    };
    await sendEmail({
      to: user.email,
      subject: 'Reset your LOCUS password',
      html: getLocusEmailHtml(parts),
      text: getLocusEmailText(parts),
    });

    res.json({ message: 'If that email is registered, a password reset link has been sent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/reset-password — verify token and update password
router.post('/reset-password', async (req, res) => {
  try {
    const { id, token, newPassword } = req.body;
    if (!id || !token || !newPassword) {
      return res.status(400).json({ error: 'ID, token, and new password are required' });
    }

    const user = await User.findById(id);
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });

    const secret = process.env.JWT_SECRET + user.password;
    try {
      jwt.verify(token, secret);
    } catch (err) {
      return res.status(400).json({ error: 'This reset link has expired or has already been used.' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password reset successfully! You can now log in.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/fcm-token — Save Firebase Cloud Messaging token
router.put('/fcm-token', protect, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    // Remove this token from any other users to prevent cross-login push notifications
    await User.updateMany(
      { fcm_token: token, _id: { $ne: req.user.id } },
      { $set: { fcm_token: null } }
    );

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.fcm_token = token;
    await user.save();

    res.json({ message: 'FCM token updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/rtmp-host — Return the RTMP server host for camera links
router.get('/rtmp-host', protect, (req, res) => {
  if (process.env.RTMP_HOST) {
    return res.json({ host: process.env.RTMP_HOST });
  }
  // Auto-detect local network IP, preferring Wi-Fi over virtual adapters
  const os = require('os');
  const interfaces = os.networkInterfaces();
  
  let bestIp = 'localhost';
  for (const name of Object.keys(interfaces)) {
    // Skip virtual network adapters
    if (name.toLowerCase().includes('vmware') || name.toLowerCase().includes('virtual')) {
      continue;
    }
    
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // If it's a VirtualBox default host-only IP, skip it if possible
        if (iface.address.startsWith('192.168.56.')) continue;
        
        bestIp = iface.address;
        // If we found the Wi-Fi adapter, use it immediately
        if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wlan')) {
          return res.json({ host: bestIp });
        }
      }
    }
  }
  res.json({ host: bestIp });
});

// PUT /api/auth/preferences - Update notification preferences
router.put('/preferences', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    user.notification_prefs = { ...user.notification_prefs, ...req.body };
    await user.save();
    res.json({ message: 'Preferences updated successfully', notification_prefs: user.notification_prefs });
  } catch (err) {
    console.error('[Auth] PUT /api/auth/preferences ERROR:', err.message);
    res.status(500).json({ error: 'Server error updating preferences' });
  }
});

module.exports = router;