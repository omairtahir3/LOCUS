const User = require('../models/User');

/**
 * Whose data this request is about.
 *
 * Eight routes had written this for themselves and they had drifted into
 * three different behaviours, which is how a caregiver with two people in
 * their care could be shown one person on one screen and another on the next:
 *
 *   honoured ?userId          /event-logs/timeline, /ask, conversations
 *   IGNORED ?userId           /event-logs/keyframes, /relationships, items
 *   authorised the id         /location only
 *
 * The second group always answered about monitoring_users[0] -- the FIRST
 * person on the list, never mind who was selected. With one person monitored
 * that is right by accident, which is why it survived; with two it is simply
 * the wrong patient's faces, frames and belongings under the right heading.
 *
 * The first group had the opposite problem. They took the id from the query
 * and never checked it, so any signed-in caregiver could read any household's
 * timeline or conversations by typing a different id into the URL.
 *
 * One rule now, in one place:
 *
 *   - a wearer always reads themselves, whatever the query string says
 *   - a caregiver reads the person they asked for, IF they look after them
 *   - an id they have no business with falls back to their own account,
 *     which holds no wearer data, rather than to another patient's
 *   - no id at all keeps the old default: the first person they monitor
 */
async function scopedUserId(req) {
  if (req.user.role !== 'caregiver') return req.user.id;

  const asked = (req.query.userId || req.query.user_id || '').toString().trim();
  const cg = await User.findById(req.user.id).select('monitoring_users').lean();
  const monitored = (cg?.monitoring_users || []).map(String);

  if (asked) return monitored.includes(asked) ? asked : req.user.id;
  return monitored.length ? monitored[0] : req.user.id;
}

module.exports = { scopedUserId };
