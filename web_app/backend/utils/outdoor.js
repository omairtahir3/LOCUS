/**
 * Outdoor detection from GPS, for item tracking (Core FE-12..15).
 *
 * "Outdoors" here means: a recent, trustworthy GPS fix is further from the
 * user's home_location than GPS noise can explain. Two thresholds, both set
 * from the fixes in this database rather than guessed:
 *
 *   accuracy   averages 20 m and reaches 100 m. A fix worse than MAX_FIX_ACCURACY_M
 *              is not trusted at all.
 *   HOME_RADIUS_M  150 m -- comfortably above the worst accepted accuracy, so a
 *              noisy fix from the living room cannot read as "outdoors".
 *
 * A vision-based outdoor scene also exists (ai/scene.py) and labels sessions
 * in the feed; this GPS path is what the live monitor uses, because location
 * is reported continuously by the phone while vision sessions are only written
 * after they close.
 *
 * Users with no home_location cannot be classified and get `null` (unknown),
 * not `false`. The monitor treats unknown as "do nothing", never as indoors.
 */

const LocationLog = require('../models/LocationLog');

const HOME_RADIUS_M = 150;
const MAX_FIX_ACCURACY_M = 100;
const MAX_FIX_AGE_MIN = 10;

/** Great-circle distance in metres. */
function haversineM(a, b) {
  const R = 6371000, toR = x => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Most recent TRUSTWORTHY fix within the age window, or null. Walks back past
 * fixes that fail the accuracy bar rather than returning null on the first one:
 * a phone indoors near a window routinely emits one 150 m fix between good
 * ones, and that must not blind the outdoor check for a whole cycle.
 */
async function latestFix(userId, now = new Date()) {
  const fixes = await LocationLog.find({
    user_id: { $in: [userId, String(userId)] },
    timestamp: { $gte: new Date(now.getTime() - MAX_FIX_AGE_MIN * 60000), $lte: now },
  }).sort({ timestamp: -1 }).limit(10).lean();
  return fixes.find(f =>
    typeof f.lat === 'number' && typeof f.lng === 'number' && (f.accuracy || 0) <= MAX_FIX_ACCURACY_M
  ) || null;
}

/**
 * @returns {Promise<{outdoors: boolean, fix: object, distance_m: number} | null>}
 *   null when it cannot be determined (no home set, no recent fix).
 */
async function outdoorStatus(user, now = new Date()) {
  const home = user.home_location;
  if (!home || typeof home.lat !== 'number' || typeof home.lng !== 'number') return null;
  const fix = await latestFix(user._id, now);
  if (!fix) return null;
  const distance_m = haversineM(home, fix);
  return { outdoors: distance_m > HOME_RADIUS_M, fix, distance_m };
}

module.exports = { outdoorStatus, latestFix, haversineM, HOME_RADIUS_M, MAX_FIX_ACCURACY_M, MAX_FIX_AGE_MIN };
