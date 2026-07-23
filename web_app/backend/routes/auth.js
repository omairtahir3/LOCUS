const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { sendEmail } = require('../utils/notifications');
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
      audience: process.env.GOOGLE_CLIENT_ID,
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

    await sendEmail({
      to: user.email,
      subject: '🔒 LOCUS Password Reset Request',
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin: 0; padding: 0; background-color: #0f172a; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #0f172a; padding: 40px 10px;">
            <tr>
              <td align="center">
                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #1e293b; border-radius: 16px; overflow: hidden; border: 1px solid #334155; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);">
                  <tr>
                    <td style="background: linear-gradient(135deg, #090d16 0%, #172030 100%); padding: 32px; border-bottom: 3px solid #0ea5e9; text-align: center;">
                      <table border="0" cellpadding="0" cellspacing="0" width="100%">
                        <tr><td align="center" style="font-size: 28px; font-weight: 900; letter-spacing: 2px; color: #ffffff;"><span style="color: #38bdf8;">⚡</span> LOCUS</td></tr>
                        <tr><td align="center" style="font-size: 11px; font-weight: 700; letter-spacing: 4px; color: #94a3b8; padding-top: 6px;">COGNITIVE CARE ASSISTANT</td></tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 40px 32px; color: #f8fafc;">
                      <table border="0" cellpadding="0" cellspacing="0">
                        <tr><td style="background-color: #0c4a6e; color: #38bdf8; font-size: 11px; font-weight: 800; letter-spacing: 1px; padding: 6px 14px; border-radius: 9999px; text-transform: uppercase;">🔒 PASSWORD RESET</td></tr>
                      </table>
                      <h1 style="margin: 22px 0 14px 0; font-size: 24px; font-weight: 800; color: #ffffff;">Reset Your Password</h1>
                      <div style="font-size: 16px; color: #e2e8f0; line-height: 1.6; background-color: #0f172a; padding: 20px 24px; border-left: 4px solid #0ea5e9; border-radius: 8px; margin-top: 16px;">
                        We received a request to reset the password for your LOCUS account (<b>${user.email}</b>). This secure reset link is valid for <b>15 minutes</b>.
                      </div>
                      <table border="0" cellpadding="0" cellspacing="0" style="margin-top: 28px; width: 100%;">
                        <tr>
                          <td align="center">
                            <a href="${resetUrl}" style="background-color: #0ea5e9; color: #ffffff; font-weight: 700; font-size: 15px; padding: 16px 36px; border-radius: 8px; text-decoration: none; display: inline-block; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.4);">
                              🔐 Reset My Password
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="background-color: #090d16; padding: 24px 32px; border-top: 1px solid #334155; text-align: center; font-size: 12px; color: #64748b;">
                      If you did not request a password reset, please ignore this email. Your account password will remain unchanged.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
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

module.exports = router;