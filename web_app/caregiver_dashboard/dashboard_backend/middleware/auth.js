const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Protect routes — verifies JWT token
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authorized, no token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.sub).select('-password');
    if (!req.user) return res.status(401).json({ error: 'User not found' });
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Restrict to specific roles
const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: `Role '${req.user.role}' is not authorized for this route` });
  }
  next();
};

// Caregiver must be linked to the user they are accessing
const caregiverAccessCheck = async (req, res, next) => {
  const targetUserId = req.params.userId || req.query.userId;
  if (!targetUserId) return next();

  if (req.user.role === 'admin') return next();

  // User accessing their own data
  if (req.user._id.toString() === targetUserId) return next();

  // Caregiver checking if they have access to this user
  if (req.user.role === 'caregiver') {
    const isLinked = req.user.monitoring_users.some(
      id => id.toString() === targetUserId
    );
    if (isLinked) return next();
  }

  return res.status(403).json({ error: 'You do not have access to this user\'s data' });
};

module.exports = { protect, authorize, caregiverAccessCheck };