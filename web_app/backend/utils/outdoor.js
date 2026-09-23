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
 * Rather than leave the whole feature inert until somebody remembers to set it
 * -- 18 of 19 accounts had not, so FE-12..15 could never fire -- home is
 * inferred from where the phone spends the night when it has not been set by
 * hand. See inferHomeLocation.
 */

const LocationLog = require('../models/LocationLog');
const User = require('../models/User');

const HOME_RADIUS_M = 150;
const MAX_FIX_ACCURACY_M = 100;
const MAX_FIX_AGE_MIN = 10;

// Home inference: the phone is at home overnight. Anything else (work, a
// relative's house) is not somewhere you sleep every night for a fortnight.
const HOME_INFER_DAYS = 14;
const HOME_INFER_START_HOUR = 1;     // 01:00 to 05:00 local, the hours nobody
const HOME_INFER_END_HOUR = 5;       // is out by choice
const HOME_INFER_MIN_FIXES = 20;     // too few and one night out skews it
const HOME_INFER_MIN_NIGHTS = 3;     // on at least this many separate nights

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

const hasCoords = h => !!h && typeof h.lat === 'number' && typeof h.lng === 'number';

/**
 * Work out where someone lives from where their phone sits overnight.
 *
 * The median of the small-hours fixes, not the mean: a median is unmoved by
 * the occasional night away or a single wild fix, while a mean is dragged by
 * both. Requires fixes from several separate nights so one late trip cannot
 * define home.
 *
 * @returns {Promise<{lat,lng,inferred,fixes,nights} | null>} null when there
 *   is not enough history to say, which leaves the user unclassified rather
 *   than guessing a home and mislabelling their living room as outdoors.
 */
async function inferHomeLocation(userId, now = new Date()) {
  const fixes = await LocationLog.find({
    user_id: { $in: [userId, String(userId)] },
    timestamp: { $gte: new Date(now.getTime() - HOME_INFER_DAYS * 86400000), $lte: now },
  }).select({ lat: 1, lng: 1, accuracy: 1, timestamp: 1 }).lean();

  const nightly = fixes.filter(f => {
    if (typeof f.lat !== 'number' || typeof f.lng !== 'number') return false;
    if ((f.accuracy || 0) > MAX_FIX_ACCURACY_M) return false;
    const h = new Date(f.timestamp).getHours();
    return h >= HOME_INFER_START_HOUR && h < HOME_INFER_END_HOUR;
  });
  if (nightly.length < HOME_INFER_MIN_FIXES) return null;

  const nights = new Set(nightly.map(f => new Date(f.timestamp).toDateString()));
  if (nights.size < HOME_INFER_MIN_NIGHTS) return null;

  const median = xs => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    lat: median(nightly.map(f => f.lat)),
    lng: median(nightly.map(f => f.lng)),
    inferred: true,
    fixes: nightly.length,
    nights: nights.size,
  };
}

/**
 * The user's home, set by hand if they have set one, inferred otherwise.
 * An inferred home is written back to the user so the work is done once and
 * so a caregiver can see (and correct) what the system decided.
 */
async function resolveHome(user, now = new Date()) {
  if (hasCoords(user.home_location)) return user.home_location;
  const inferred = await inferHomeLocation(user._id, now);
  if (!inferred) return null;
  const home = { lat: inferred.lat, lng: inferred.lng, address: null, inferred: true };
  await User.findByIdAndUpdate(user._id, { $set: { home_location: home } });
  user.home_location = home;   // so the caller's copy is usable immediately
  console.log(`[Outdoor] inferred home for ${user.name} from ${inferred.fixes} overnight fixes `
    + `across ${inferred.nights} nights; set it in Settings to override`);
  return home;
}

/**
 * @returns {Promise<{outdoors: boolean, fix: object, distance_m: number} | null>}
 *   null when it cannot be determined (no home known, no recent fix).
 */
async function outdoorStatus(user, now = new Date()) {
  const home = await resolveHome(user, now);
  if (!hasCoords(home)) return null;
  const fix = await latestFix(user._id, now);
  if (!fix) return null;
  const distance_m = haversineM(home, fix);
  return { outdoors: distance_m > HOME_RADIUS_M, fix, distance_m };
}

module.exports = {
  outdoorStatus, latestFix, haversineM, inferHomeLocation, resolveHome,
  HOME_RADIUS_M, MAX_FIX_ACCURACY_M, MAX_FIX_AGE_MIN,
  HOME_INFER_DAYS, HOME_INFER_MIN_FIXES, HOME_INFER_MIN_NIGHTS,
};
