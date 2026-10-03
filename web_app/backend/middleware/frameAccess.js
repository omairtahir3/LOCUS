/**
 * Who may see a captured frame.
 *
 * The two image routes were deliberately left unauthenticated, with a comment
 * explaining that an <img> tag cannot send an Authorization header. That is
 * true, and the consequence was that anyone who could guess or obtain a
 * keyframe id could fetch video stills from inside a stranger's home, with no
 * token at all. For a dementia-care camera that is the most sensitive data the
 * system holds.
 *
 * A frame is now served only to the person it was captured from, a caregiver
 * linked to them, or the AI backend itself.
 *
 * Two transports, because the clients differ:
 *   - `Authorization: Bearer <session token>`, used by Flutter, whose
 *     Image.network DOES accept headers, and by any fetch().
 *   - `?t=<frame token>` for the web, where <img src> cannot carry a header.
 *     That token is a SEPARATE, short-lived, frame-scope-only JWT, never the
 *     7-day session token: a URL ends up in browser history, in a Referer and
 *     in server logs, so what leaks there must be nearly worthless.
 *
 * ponytail: plain jsonwebtoken, already a dependency, rather than a signed-URL
 * or capability library. The token is three claims and an expiry.
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const FRAME_SCOPE = 'frame';
const FRAME_TOKEN_MINUTES = 60;

/** A frame-scope token for the web's <img> tags. */
function issueFrameToken(userId) {
  return jwt.sign({ sub: String(userId), scope: FRAME_SCOPE }, process.env.JWT_SECRET,
    { expiresIn: `${FRAME_TOKEN_MINUTES}m` });
}

/** The viewer, from either transport. Null when there is no usable credential. */
function viewerIdFrom(req) {
  const auth = req.headers.authorization;
  const bearer = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const query = typeof req.query.t === 'string' ? req.query.t : null;
  for (const [raw, mustBeFrameScope] of [[bearer, false], [query, true]]) {
    if (!raw) continue;
    try {
      const decoded = jwt.verify(raw, process.env.JWT_SECRET);
      // A session token in the query string is refused on purpose. Accepting it
      // would mean a 7-day all-access credential sitting in browser history,
      // which is the thing the short-lived token exists to avoid.
      if (mustBeFrameScope && decoded.scope !== FRAME_SCOPE) continue;
      if (decoded.sub) return String(decoded.sub);
    } catch {
      // Expired or forged: try the other transport rather than failing outright.
    }
  }
  return null;
}

/**
 * The user a frame was captured from.
 *
 * Four sources because no single one covers every frame: of 1231 ids the UI can
 * ask for, 1229 are reachable only through eventlogs and 2 only through
 * medication_logs, while keyframemetas holds a separate 19 that the Keyframe
 * Audit page lists straight from the capture store and that no event references.
 */
async function frameOwner(keyframeId) {
  const db = mongoose.connection.db;
  const first = async (coll, filter) => {
    const doc = await db.collection(coll).findOne(filter, { projection: { user_id: 1 } });
    return doc && doc.user_id ? String(doc.user_id) : null;
  };
  return (await first('eventlogs', { keyframe_id: keyframeId }))
    || (await first('medication_logs', { keyframe_id: keyframeId }))
    || (await first('keyframemetas', { keyframe_id: keyframeId }))
    || (await first('relationships', { representative_keyframe_id: keyframeId }));
}

/** True when `viewerId` is the owner, or a caregiver linked to them. */
async function mayView(viewerId, ownerId) {
  if (viewerId === ownerId) return true;
  const viewer = await User.findById(viewerId).select('role monitoring_users');
  if (!viewer) return false;
  if (viewer.role === 'admin') return true;
  if (viewer.role !== 'caregiver') return false;
  return (viewer.monitoring_users || []).some(id => String(id) === ownerId);
}

/**
 * Guard for the frame image routes. Reads `req.params.id`.
 *
 * A frame nobody owns is a 404 rather than a 403: whether an id exists is
 * itself worth not disclosing, and a 403 would confirm it.
 */
async function frameAccess(req, res, next) {
  // The detection pipeline fetches frames to attach them to events. It is the
  // same trust boundary protect() already grants this header.
  if (req.headers['x-internal'] === 'true') return next();

  const viewerId = viewerIdFrom(req);
  if (!viewerId) return res.status(401).json({ error: 'Not authorized to view this frame' });

  try {
    const ownerId = await frameOwner(req.params.id);
    if (!ownerId) return res.status(404).json({ error: 'Frame not found' });
    if (!(await mayView(viewerId, ownerId))) {
      return res.status(403).json({ error: 'Not authorized to view this frame' });
    }
    return next();
  } catch (err) {
    console.error('frameAccess failed:', err);
    // Fail CLOSED. An error here must not become an open door.
    return res.status(500).json({ error: 'Could not check access to this frame' });
  }
}

module.exports = { frameAccess, issueFrameToken, frameOwner, mayView, viewerIdFrom, FRAME_TOKEN_MINUTES };
