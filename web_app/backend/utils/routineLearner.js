/**
 * Routine learner: builds one RoutineProfile per user from their own history.
 *
 * Deterministic on purpose. The pattern being learned is "how often does X
 * happen at hour H on a weekday/weekend", which is a count, and a count is
 * inspectable, reproducible, and cannot hallucinate a routine out of four data
 * points -- the failure mode this whole project keeps fighting. An LLM sits
 * ABOVE this layer (phrasing findings, triaging what to send) and never inside
 * it.
 *
 * Inputs, all keyed on user_id, all limited to the last BASELINE_DAYS:
 *   eventlogs   details.action == 'scene_session'  -> "scene:<room>"
 *   eventlogs   event_type == 'object'              -> "item:<enrolled_item_id>"
 *   medication_logs  status == 'taken'              -> "medication"
 *
 * Every user gets their own profile; there is no shared or population model.
 */

const mongoose = require('mongoose');
const RoutineProfile = require('../models/RoutineProfile');
const EventLog = require('../models/EventLog');
const MedicationLog = require('../models/MedicationLog');

const BASELINE_DAYS = 30;

// A signal is "expected" at a slot when it occurred on at least this share of
// the observed days of that type. 0.6 = "most days", tolerant of a missed day
// or two per week without declaring the routine broken.
const EXPECTED_RATIO = 0.6;

// Below this many observed days the profile cannot support any "expected"
// claim, and the monitor's deviation checks stay off.
// How many days of a given KIND must be seen before this will claim anything.
//
// One number for both was a bug that could never fire. It is checked against
// days_observed.weekday or days_observed.weekend separately, but the baseline
// window is 30 days, which contains about 21 weekdays and only about 9 weekend
// days. Requiring 14 of each meant weekend expectations were mathematically
// unreachable: a weekend deviation could not be raised, ever, no matter how
// long anyone wore the camera.
//
// Roughly half the days of that kind that a 30-day window can hold. Half is the
// judgement; the asymmetry is arithmetic.
const MIN_DAYS_FOR_EXPECTATIONS = { weekday: 10, weekend: 5 };

/** The bar for this kind of day. */
function minDaysFor(type) {
  return MIN_DAYS_FOR_EXPECTATIONS[type] ?? 10;
}

const dayKey = d => d.toISOString().slice(0, 10);
const dayType = d => (d.getDay() === 0 || d.getDay() === 6) ? 'weekend' : 'weekday';

function emptySignal(key, label = '') {
  return {
    key, label,
    hist: { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) },
    total: 0,
    mean_duration_min: null,
    rooms: {},
    // scratch, stripped before save: set of "YYYY-MM-DD:HH" already counted so
    // a signal firing three times in one hour counts that hour ONCE for the day
    _seen: new Set(),
    _durations: [],
  };
}

function bump(sig, when, opts = {}) {
  const key = `${dayKey(when)}:${when.getHours()}`;
  if (!sig._seen.has(key)) {
    sig._seen.add(key);
    sig.hist[dayType(when)][when.getHours()] += 1;
  }
  sig.total += 1;
  if (opts.durationMin != null) sig._durations.push(opts.durationMin);
  if (opts.room) sig.rooms[opts.room] = (sig.rooms[opts.room] || 0) + 1;
}

/**
 * Build (or rebuild) the profile for one user. Returns the saved document.
 */
async function buildProfile(user) {
  const uid = user._id;
  const idForms = [uid, String(uid)];
  const since = new Date(Date.now() - BASELINE_DAYS * 86400000);

  const signals = new Map();
  const get = (key, label) => {
    if (!signals.has(key)) signals.set(key, emptySignal(key, label));
    return signals.get(key);
  };
  const daysSeen = { weekday: new Set(), weekend: new Set() };
  const noteDay = d => daysSeen[dayType(d)].add(dayKey(d));

  // ── scene sessions ──────────────────────────────────────────────────────
  const sessions = await EventLog.find({
    user_id: { $in: idForms }, event_type: 'activity',
    'details.action': 'scene_session', timestamp: { $gte: since },
  }).lean();
  for (const s of sessions) {
    const room = s.details?.scene;
    if (!room) continue;
    const start = new Date(s.timestamp);
    const durMin = (s.details?.duration_seconds || 0) / 60;
    noteDay(start);
    const sig = get(`scene:${room}`, room);
    // a long session spans several hours; mark each hour it covered
    const hours = Math.max(1, Math.ceil(durMin / 60));
    for (let h = 0; h < hours; h++) {
      bump(sig, new Date(start.getTime() + h * 3600000), h === 0 ? { durationMin: durMin } : {});
    }
  }

  // ── enrolled item sightings ─────────────────────────────────────────────
  //
  // Keyed on the belonging's CURRENT id, resolved through its name.
  //
  // A sighting stores the item id that was enrolled when it happened. Enrolling
  // the same thing again gives it a new id, so keying on the stored one threw
  // away every routine this person had: a month of knowing when they pick up
  // their keys became two signals pointing at ids that no longer exist, and two
  // new ids with no history. Re-enrolling an item to improve its photographs
  // should not cost the system its memory of when that item is used.
  //
  // Matched by name within one person's own belongings, which they chose and
  // typed. Signals for a name that is no longer enrolled are dropped rather
  // than kept pointing at nothing.
  const UserItem = require('../models/UserItem');
  const currentItems = await UserItem.find({ user_id: { $in: idForms } })
    .select('item_name').lean();
  const idForName = new Map(
    currentItems.map(i => [String(i.item_name || '').trim().toLowerCase(), String(i._id)]));

  const objects = await EventLog.find({
    user_id: { $in: idForms }, event_type: 'object', timestamp: { $gte: since },
  }).lean();
  // room at the time of each sighting, by joining onto the session that
  // contained it. Sessions are closed after the fact, so this is the only
  // place the item->room association is recoverable.
  const sessionSpans = sessions.map(s => ({
    room: s.details?.scene,
    start: +new Date(s.timestamp),
    end: +new Date(s.timestamp) + (s.details?.duration_seconds || 0) * 1000,
  }));
  const roomAt = t => {
    const hit = sessionSpans.find(sp => t >= sp.start && t <= sp.end);
    return hit ? hit.room : null;
  };
  for (const o of objects) {
    const when = new Date(o.timestamp);
    noteDay(when);
    for (const it of (o.details?.items || [])) {
      if (!it.enrolled_item_id || !it.matched_item) continue;
      // The id this belonging has NOW, not the one it had when it was seen.
      const currentId = idForName.get(String(it.matched_item).trim().toLowerCase());
      // No current id means the belonging has been removed, not re-enrolled, so
      // its history is not carried forward into a signal nothing can match.
      if (!currentId) continue;
      const sig = get(`item:${currentId}`, it.matched_item);
      bump(sig, when, { room: roomAt(+when) });
    }
  }

  // ── medication taken ────────────────────────────────────────────────────
  const taken = await MedicationLog.find({
    user_id: { $in: idForms }, status: 'taken', taken_at: { $gte: since },
  }).lean();
  for (const m of taken) {
    const when = new Date(m.taken_at);
    noteDay(when);
    bump(get('medication', 'Medication'), when);
  }

  // ── finalise ────────────────────────────────────────────────────────────
  const out = [];
  for (const sig of signals.values()) {
    const d = sig._durations;
    out.push({
      key: sig.key, label: sig.label, hist: sig.hist, total: sig.total,
      mean_duration_min: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null,
      rooms: sig.rooms,
    });
  }

  const doc = await RoutineProfile.findOneAndUpdate(
    { user_id: uid },
    {
      user_id: uid, role: user.role, built_at: new Date(), baseline_days: BASELINE_DAYS,
      days_observed: { weekday: daysSeen.weekday.size, weekend: daysSeen.weekend.size },
      signals: out,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

/**
 * Is `signalKey` expected for this user at the given moment?
 * Returns { expected, ratio, support } so the monitor can explain itself.
 */
function expectation(profile, signalKey, when = new Date()) {
  const type = dayType(when);
  const observed = profile.days_observed?.[type] || 0;
  const sig = (profile.signals || []).find(s => s.key === signalKey);
  if (!sig || observed < minDaysFor(type)) {
    return { expected: false, ratio: 0, support: observed, insufficient: true };
  }
  const seen = sig.hist?.[type]?.[when.getHours()] || 0;
  const ratio = seen / observed;
  return { expected: ratio >= EXPECTED_RATIO, ratio, support: observed, insufficient: false };
}

/**
 * Rebuild every non-caregiver user's profile. Caregivers are observers; they
 * have no routine of their own to learn.
 */
async function rebuildAllProfiles() {
  const User = require('../models/User');
  const users = await User.find({ role: { $in: ['user', 'elderly'] } }).lean();
  let built = 0;
  for (const u of users) {
    try {
      const p = await buildProfile(u);
      built++;
      console.log(`[RoutineLearner] ${u.name} (${u.role}): ${p.signals.length} signals, `
        + `${p.days_observed.weekday}wd/${p.days_observed.weekend}we days observed`);
    } catch (e) {
      console.error(`[RoutineLearner] failed for ${u.name}: ${e.message}`);
    }
  }
  return built;
}

const REBUILD_INTERVAL_MS = 24 * 60 * 60 * 1000;

function init() {
  console.log(`[RoutineLearner] active — ${BASELINE_DAYS}-day baseline, rebuilt daily`);
  // First build shortly after boot so the monitor has something to read, then daily.
  setTimeout(() => rebuildAllProfiles().catch(e => console.error('[RoutineLearner]', e.message)), 60 * 1000);
  setInterval(() => rebuildAllProfiles().catch(e => console.error('[RoutineLearner]', e.message)), REBUILD_INTERVAL_MS);
}

module.exports = {
  init, buildProfile, rebuildAllProfiles, expectation,
  BASELINE_DAYS, EXPECTED_RATIO, MIN_DAYS_FOR_EXPECTATIONS, minDaysFor,
};
