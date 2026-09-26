/**
 * Routine monitor: compares what is happening now against each user's profile
 * and raises findings. Runs every MONITOR_INTERVAL_MS.
 *
 * Role-gated. Elderly users are monitored on behalf of their caregivers;
 * normal users get reminders for themselves; caregivers are never monitored.
 *
 *   elderly  -> medication_gap, inactivity, camera_off, deviation   (to caregivers)
 *   user     -> left_behind, habitual_item                          (to the user)
 *
 * Every check is deterministic and every threshold below was set from the real
 * data in this database, not from taste. Findings are recorded in
 * routine_findings whether or not they are surfaced, and dedup_key prevents the
 * same finding being raised again on the next run.
 */

const RoutineProfile = require('../models/RoutineProfile');
const RoutineFinding = require('../models/RoutineFinding');
const EventLog = require('../models/EventLog');
const MedicationLog = require('../models/MedicationLog');
const { expectation } = require('./routineLearner');
const { dateWords, timeWords, hourWords, distanceWords, item: itemWords, firstName } = require('./friendly');

// Must be SHORTER than the shortest thing being waited for, or the wait and the
// poll add up. At 15 minutes with LEFT_BEHIND_AFTER_MIN at 10, a phone left on a
// desk could not be reported for up to 25 minutes, which is long past the point
// the wearer could turn round and fetch it: measured, a wearer who walked off at
// 19:39 had had no alert by 19:53. One full pass over all 17 users in this
// database costs 820 ms, so the old interval was never a performance decision.
// 2 minutes puts the alert within about a minute of coming due, for 0.7% of one
// core. Every check is dedup-keyed, so running them more often cannot duplicate
// an alert; it only notices sooner.
const MONITOR_INTERVAL_MS = 2 * 60 * 1000;

// ── Medication gap (elderly) ────────────────────────────────────────────────
// Alert when this many consecutive days end with no verified dose. Re-alert only
// each time the gap grows by another MED_GAP_DAYS, so a 10-day gap produces
// alerts at 3, 6 and 9 -- not ten of them.
const MED_GAP_DAYS = 3;

// ── Inactivity (elderly) ────────────────────────────────────────────────────
// The keyframe extractor writes a scene_change event with motion_score for every
// keyframe it saves, so those events are a liveness heartbeat. Measured over 449
// of them: motion_score median 8.1, p25 4.4, p10 2.5. Sitting still is the
// bottom quartile, so a window whose PEAK stays under 5.0 is inactivity.
const INACTIVITY_HOURS = 3;
const MOTION_FLOOR = 5.0;
// Keyframe gaps while streaming: median 25s, p90 126s, p99 20min. A gap past 30
// minutes is not "sitting still", it is "no camera", which is a different alert.
const STREAM_ALIVE_MIN = 30;
const CAMERA_OFF_HOURS = 4;
// Only during waking hours. Asleep is not inactive.
const WAKING_START_HOUR = 7;
const WAKING_END_HOUR = 23;

// ── Left-behind item (user) ─────────────────────────────────────────────────
// When a scene session closes (the user left that room), any enrolled item last
// seen in that room during the session and not seen since is left behind.
const LEFT_BEHIND_WINDOW_MIN = 10;

// How long an item must have been out of view, having last been seen PUT DOWN,
// before it counts as left behind. Used only when the indexer has NOT refreshed
// visibility, which is the pre-existing situation and the cautious direction:
// without a refresh, "not logged again" is weak evidence, because a sighting is
// logged once per fifteen minutes whether or not the item is still in view.
const LEFT_BEHIND_AFTER_MIN = 10;

// The same claim, once visibility IS being refreshed. Much shorter, because the
// evidence is much stronger: the indexer stamps "still visible" on every sighting
// it suppresses, so an item in view on the desk in front of a seated wearer keeps
// its timestamp moving and cannot look absent. Silence for this long therefore
// means the item genuinely left the view.
//
// 2 minutes, not seconds: motion cannot be used to confirm the wearer walked off
// -- measured over 571 samples, the known walk-off (mean 18.9, median 12.5) is
// indistinguishable from every other minute of the day (mean 17.2, median 10.5),
// because a chest camera moves whenever the torso does. Sightings also arrive
// irregularly, a median 17 s apart but with long gaps, so a window under a minute
// would fire on the gaps themselves. Two minutes clears the gaps while still
// telling the wearer while they are only a room or a floor away.
const ITEM_GONE_MIN = Number(process.env.ITEM_GONE_MIN || 2);

// How long after a room session ends a sighting may still count as having
// happened in that room. One keyframe's worth, no more: a session ends at its
// last confirmed sighting of the room, so a genuine last glimpse of the item
// can trail it by a frame, but anything later means the item is still being
// seen and therefore went with the wearer.
const LEFT_BEHIND_EXIT_TOLERANCE_MS = 60 * 1000;

// ── Outdoor item loss (both roles) — Core FE-12, FE-15 ──────────────────────
// A chest camera cannot see an item in a pocket or a bag, so "not seen for N
// minutes outdoors" would fire constantly and is NOT the rule. The detectable
// event is: the item was sighted at GPS point S while outdoors, the wearer has
// since moved further from S than GPS noise allows, and the item has not been
// seen since. That is "you left it there", and S is where to send them back to.
const ITEM_LOST_LOOKBACK_HOURS = 3;
// 75 m: above the worst accepted GPS accuracy (100 m fixes are rejected; the
// average is 20 m), so two fixes from the same bench cannot read as "walked away".
const ITEM_LOST_MOVE_RADIUS_M = 75;
// FE-15: if the wearer has not acknowledged the loss alert within this window,
// caregivers are told, with the last-seen GPS, keyframe and timestamp.
const ITEM_LOST_ESCALATE_MIN = 10;

// ── Routine deviation (elderly, gated on profile support) ──────────────────
// If a scene is expected at this hour and has not been seen since this many
// hours before, the routine has slipped. Two hours absorbs ordinary variation.
const DEVIATION_GRACE_HOURS = 2;

// Every check takes `now` as a parameter and does all time arithmetic against
// it, so behaviour is a pure function of (database, now). Production passes the
// real clock; tests pass a fixed one and get reproducible answers -- including
// for the waking-hours gate, which would otherwise make a 3 a.m. test run
// silently skip every inactivity case.
const hoursAgo = (h, now) => new Date(now.getTime() - h * 3600000);
const minutesAgo = (m, now) => new Date(now.getTime() - m * 60000);
const dayKey = d => d.toISOString().slice(0, 10);
const isWakingHours = d => d.getHours() >= WAKING_START_HOUR && d.getHours() < WAKING_END_HOUR;
const idForms = uid => [uid, String(uid)];

/** Record a finding once. Returns the new document, or null if already known. */
async function record(user, kind, dedup_key, severity, title, message, evidence = {}) {
  try {
    return await RoutineFinding.create({ user_id: user._id, kind, dedup_key, severity, title, message, evidence });
  } catch (e) {
    if (e.code === 11000) return null;   // dedup_key already recorded
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Elderly checks
// ═══════════════════════════════════════════════════════════════════════════

async function checkMedicationGap(user, now = new Date()) {
  // Walk back from today counting consecutive days with no 'taken'. Stop at the
  // first day that had one. A day with no scheduled dose at all does not break
  // or extend the gap -- it simply is not evidence either way.
  const lookback = 60;
  const since = new Date(now.getTime() - lookback * 86400000);
  const logs = await MedicationLog.find({ user_id: { $in: idForms(user._id) }, scheduled_time: { $gte: since } })
    .sort({ scheduled_time: -1 }).lean();
  if (!logs.length) return null;

  const byDay = new Map();
  for (const l of logs) {
    const k = dayKey(new Date(l.scheduled_time));
    if (!byDay.has(k)) byDay.set(k, { taken: 0, missed: 0, camera_off: 0, scheduled: 0, other: 0 });
    const d = byDay.get(k);
    if (l.status === 'taken') d.taken++;
    else if (l.status === 'missed') d.missed++;
    else if (l.status === 'camera_off' || l.status === 'skipped') d.camera_off++;
    else if (l.status === 'scheduled') d.scheduled++;
    else d.other++;
  }

  const gapDays = [];
  let missedAny = false, cameraOffAll = true;
  for (let i = 0; i < lookback; i++) {
    const day = new Date(now.getTime() - i * 86400000);
    const k = dayKey(day);
    const d = byDay.get(k);
    if (!d) continue;                         // nothing scheduled: no evidence
    if (d.taken > 0) break;                   // gap ends here
    if (d.scheduled > 0 && d.missed + d.camera_off === 0) continue; // still pending today
    gapDays.push(k);
    if (d.missed > 0) missedAny = true;
    if (d.missed > 0 || d.other > 0) cameraOffAll = false;
  }
  if (gapDays.length < MED_GAP_DAYS) return null;

  const bucket = Math.floor(gapDays.length / MED_GAP_DAYS);       // 3->1, 6->2, ...
  const gapStart = gapDays[gapDays.length - 1], gapEnd = gapDays[0];
  const dedup_key = `${user._id}:medgap:${gapStart}:${bucket}`;

  // camera_off is not "missed" -- it needs a different response from the
  // caregiver (check the device) than a genuinely missed dose does (check the person).
  const who = firstName(user.name), n = gapDays.length;
  const sinceWords = dateWords(gapStart);
  let title, message;
  if (cameraOffAll) {
    title = `${who}'s doses haven't been confirmed for ${n} days`;
    message = `The camera has been off at every dose time since ${sinceWords}, so we can't tell whether ${who} has been taking ` +
      `medication. This may just be the device. Could you make sure the camera is on for the next dose, or confirm the recent ones by hand?`;
  } else if (missedAny) {
    title = `${who} has missed doses for ${n} days`;
    message = `The camera was on but didn't see ${who} take medication on ${n} days in a row, since ${sinceWords}. It would be worth checking in.`;
  } else {
    title = `${who}'s doses haven't been confirmed for ${n} days`;
    message = `No dose has been confirmed since ${sinceWords}. It would be worth checking in with ${who}.`;
  }
  return record(user, 'medication_gap', dedup_key, cameraOffAll ? 'warning' : 'urgent', title, message,
    { gap_start: gapStart, gap_end: gapEnd, days: gapDays.length, camera_off_all: cameraOffAll, missed_any: missedAny });
}

async function checkInactivityAndCamera(user, now = new Date()) {
  if (!isWakingHours(now)) return null;

  // Heartbeats AND scene changes. A scene_change is only written when motion
  // clears the scene threshold, so somebody sitting perfectly still produced
  // no records at all and this check reported the camera as OFF -- telling a
  // caregiver to go and look at the device when the thing that needed looking
  // at was the person. The heartbeat (ai/pipeline.py) is written every minute
  // whether or not anything moved, carrying the peak motion since the last
  // one. scene_change is still accepted so older data keeps working.
  const recent = await EventLog.find({
    user_id: { $in: idForms(user._id) },
    'details.action': { $in: ['camera_heartbeat', 'scene_change'] },
    timestamp: { $gte: hoursAgo(Math.max(INACTIVITY_HOURS, CAMERA_OFF_HOURS), now), $lte: now },
  }).sort({ timestamp: -1 }).lean();

  const last = recent[0];
  const streamAlive = last && new Date(last.timestamp) >= minutesAgo(STREAM_ALIVE_MIN, now);

  if (!streamAlive) {
    // No keyframes at all: the camera is off, not the person.
    const lastSeen = last ? new Date(last.timestamp) : null;
    const offHours = lastSeen ? (now - lastSeen) / 3600000 : Infinity;
    if (offHours < CAMERA_OFF_HOURS) return null;
    const dedup_key = `${user._id}:cameraoff:${dayKey(now)}`;
    const who = firstName(user.name);
    const hrs = offHours === Infinity ? 'more than a day' : `${Math.floor(offHours)} hours`;
    return record(user, 'camera_off', dedup_key, 'warning',
      `${who}'s camera has been off for ${hrs}`,
      `Nothing has come through from ${who}'s camera since ${lastSeen ? timeWords(lastSeen) : 'yesterday'}. ` +
      `Until it's back on, we can't watch for inactivity or keep track of their routine.`,
      { last_frame: lastSeen });
  }

  // Stream is alive: is there motion?
  const window = recent.filter(e => new Date(e.timestamp) >= hoursAgo(INACTIVITY_HOURS, now));
  if (window.length < 3) return null;   // too few frames to judge
  const peak = Math.max(...window.map(e => e.details?.motion_score ?? 0));
  if (peak >= MOTION_FLOOR) return null;

  const windowStart = new Date(Math.min(...window.map(e => +new Date(e.timestamp))));
  const dedup_key = `${user._id}:inactive:${dayKey(now)}:${windowStart.getHours()}`;
  const who = firstName(user.name);
  // Motion scores and frame counts stay in `evidence` for the audit trail; the
  // caregiver just needs to know how long and since when.
  return record(user, 'inactivity', dedup_key, 'urgent',
    `${who} hasn't moved much for ${INACTIVITY_HOURS} hours`,
    `${who}'s camera has been on since ${timeWords(windowStart)}, but there's been almost no movement in that time. ` +
    `It's probably worth checking in on ${who} now.`,
    { peak_motion: peak, frames: window.length, window_start: windowStart });
}

async function checkDeviation(user, profile, now = new Date()) {
  if (!isWakingHours(now)) return [];
  const out = [];
  for (const sig of profile.signals || []) {
    if (!sig.key.startsWith('scene:')) continue;
    const exp = expectation(profile, sig.key, now);
    if (exp.insufficient || !exp.expected) continue;
    const room = sig.key.slice('scene:'.length);
    const seen = await EventLog.exists({
      user_id: { $in: idForms(user._id) }, 'details.action': 'scene_session',
      'details.scene': room, timestamp: { $gte: hoursAgo(DEVIATION_GRACE_HOURS, now), $lte: now },
    });
    if (seen) continue;
    const dedup_key = `${user._id}:deviation:${sig.key}:${dayKey(now)}:${now.getHours()}`;
    const who = firstName(user.name);
    const f = await record(user, 'deviation', dedup_key, 'info',
      `${who} hasn't been in the ${room} yet today`,
      `${who} is usually in the ${room} around ${hourWords(now.getHours())}, but hasn't been seen there in the last ` +
      `${DEVIATION_GRACE_HOURS} hours. Nothing urgent, just a change from the usual pattern.`,
      { signal: sig.key, ratio: exp.ratio, support: exp.support });
    if (f) out.push(f);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Normal-user checks
// ═══════════════════════════════════════════════════════════════════════════

async function checkLeftBehind(user, sinceRun, now = new Date()) {
  // "You walked away and left it there."
  //
  // This used to trigger only when a room SESSION closed, and it never fired
  // once in the system's whole history. Rooms are recognised far less often
  // than items are, so the two almost never coincided, and a phone left on a
  // desk in a room the classifier could not name produced nothing at all. It
  // also keyed on the session's createdAt, which stopped meaning "just closed"
  // once sessions began being written while still open.
  //
  // The trigger is now the item itself: last seen PUT DOWN, not seen since,
  // and long enough ago to be a departure rather than a glance away. Placement
  // is what makes this safe. The reason a plain "not seen for N minutes" rule
  // was rejected for outdoor tracking is that a chest camera cannot see an item
  // in a pocket, so it would fire constantly. An item we watched leave the hand
  // onto a surface is a different claim: we know where it is, and we know it is
  // not on the person.
  // No waking-hours gate. "You left your phone in the kitchen" is worth saying
  // whenever the wearer is up; the gate meant a 22:52 sighting could only have
  // alerted at 23:02, by which time the gate had closed and the alert was lost.
  const out = [];

  const sightings = await EventLog.find({
    user_id: { $in: idForms(user._id) }, event_type: 'object',
    timestamp: { $gte: hoursAgo(ITEM_LOST_LOOKBACK_HOURS, now), $lte: now },
  }).sort({ timestamp: -1 }).lean();

  // Newest sighting per item; the list is sorted descending, so the first wins.
  // Keyed by STRING. An ObjectId is an object, so Map.has() compares by
  // reference and two ids with the same value never match: every sighting looks
  // new, the oldest one ends up winning, and the alert cites a sighting the
  // wearer has long since walked back to. It also means an item picked up again
  // still reports as left behind.
  // Every belonging is tracked independently, so two or three things left on the
  // same desk each get their own alert. Nothing here is restricted to phones.
  const lastSeen = new Map();
  for (const o of sightings) {
    for (const it of (o.details?.items || [])) {
      if (!it.enrolled_item_id || !it.matched_item) continue;
      if (lastSeen.has(String(it.enrolled_item_id))) continue;
      const placement = it.placement || o.details?.placement;
      lastSeen.set(String(it.enrolled_item_id), {
        name: it.matched_item,
        at: new Date(o.timestamp),
        keyframe_id: o.keyframe_id || null,
        placed: placement === 'placed',
        // Refreshed by the indexer on every suppressed sighting, so it means
        // "last moment we could actually SEE it", not "last moment we logged it".
        lastVisible: o.details?.last_visible_at ? new Date(o.details.last_visible_at) : null,
        // The newest sighting is the one that decides. If the last thing we saw
        // was the item in a hand, it went with them, and that is now a recorded
        // fact rather than an assumption: the indexer used to discard held
        // sightings, so "carried away" and "never seen again" were the same
        // silence and this could only be guessed at.
        inHand: placement === 'in_hand',
      });
    }
  }

  // ── Trigger 1: the wearer has just LEFT a room ───────────────────────────
  //
  // This is the moment that matters and it needs no waiting. A room session is
  // written when the visit ends, so a session that appeared since the last run
  // IS a room the wearer has walked out of. If a belonging was last seen put
  // down in that room and has not been seen since, it is still in there.
  //
  // Waiting ten minutes instead meant the alert arrived long after the wearer
  // could have turned round, and on one evening it never arrived at all.
  const justLeft = await EventLog.find({
    user_id: { $in: idForms(user._id) }, 'details.action': 'scene_session',
    updatedAt: { $gte: sinceRun },
  }).lean();

  const alerted = new Set();
  for (const sess of justLeft) {
    const room = sess.details?.scene;
    const start = new Date(sess.timestamp);
    const end = new Date(+start + (sess.details?.duration_seconds || 0) * 1000);
    const grace = LEFT_BEHIND_WINDOW_MIN * 60000;
    for (const [itemId, s] of lastSeen) {
      if (alerted.has(itemId) || !s.placed) continue;
      // Seen inside that visit. The tolerance is generous on the way IN,
      // because keyframes are sparse and the first sighting of a room often
      // predates the session being confirmed, but nearly nothing on the way
      // OUT: an item seen well after the wearer left that room is an item they
      // took with them, and reporting it as left behind would be exactly
      // backwards.
      if (s.at < new Date(+start - grace)) continue;
      if (s.at > new Date(+end + LEFT_BEHIND_EXIT_TOLERANCE_MS)) continue;
      const seenSince = await EventLog.exists({
        user_id: { $in: idForms(user._id) }, event_type: 'object',
        'details.items.enrolled_item_id': itemId, timestamp: { $gt: s.at },
      });
      if (seenSince) continue;
      const f = await raiseLeftBehind(user, itemId, s, room);
      if (f) { out.push(f); alerted.add(itemId); }
    }
  }

  // ── Trigger 2: no room needed. The item stopped being visible ────────────
  //
  // Rooms are not available: 0 of the 60 most recent item events fell inside a
  // named room session, so Trigger 1 above is a bonus that almost never fires,
  // and this is the path that actually has to work. It uses no environment at
  // all, by design, so it behaves the same upstairs, downstairs and in any room
  // the classifier will never learn to name.
  //
  // "Still visible" is refreshed by the indexer every time a sighting is
  // suppressed as a duplicate, so a belonging in view on the desk in front of a
  // seated wearer keeps its timestamp moving. Absence therefore means the item
  // left the view, not merely that it was logged once and never again, and it
  // can be trusted after ITEM_GONE_MIN rather than ten minutes.
  for (const [itemId, s] of lastSeen) {
    if (alerted.has(itemId)) continue;
    // Last seen in a hand: it went with them. Recorded now, not assumed.
    if (s.inHand) continue;
    if (!s.placed) continue;
    // Strong evidence gets the short window, weak evidence keeps the long one.
    // With a refresh, silence means the item left the view. Without one, silence
    // only means it has not been logged again, which a fifteen-minute dedup
    // guarantees anyway, so the cautious threshold still applies.
    const refreshed = s.lastVisible && s.lastVisible > s.at;
    const goneSince = refreshed ? s.lastVisible : s.at;
    const wait = refreshed ? ITEM_GONE_MIN : LEFT_BEHIND_AFTER_MIN;
    if (goneSince > minutesAgo(wait, now)) continue;

    // The camera has to have been running since. Otherwise "not seen again"
    // only means nobody was looking, which is not evidence of anything.
    const stillWatching = await EventLog.exists({
      user_id: { $in: idForms(user._id) },
      'details.action': { $in: ['camera_heartbeat', 'scene_change', 'coverage'] },
      timestamp: { $gt: s.at },
    });
    if (!stillWatching) continue;

    // Where it was, if a room was known at that moment. Absence of a room does
    // not block the alert; it only makes the wording less specific.
    let room = null;
    const session = await EventLog.findOne({
      user_id: { $in: idForms(user._id) }, 'details.action': 'scene_session',
      timestamp: { $lte: s.at },
    }).sort({ timestamp: -1 }).lean();
    if (session) {
      const end = new Date(+new Date(session.timestamp) +
        (session.details?.duration_seconds || 0) * 1000);
      // Only claim the room if the sighting actually falls inside that session.
      if (s.at <= new Date(+end + LEFT_BEHIND_WINDOW_MIN * 60000)) {
        room = session.details?.scene || null;
      }
    }

    const f = await raiseLeftBehind(user, itemId, s, room);
    if (f) { out.push(f); alerted.add(itemId); }
  }
  return out;
}

/**
 * One alert per sighting, whichever trigger noticed it.
 *
 * Deliberately NOT restricted to a phone. Anything the wearer enrolled is a
 * belonging they can walk away from, and the rule is the same for all of them:
 * last seen PUT DOWN, not seen since, and the wearer has moved on. An item last
 * seen in the hand went with them and is never reported.
 */
// The classifier's room keys are not what a person says. "in the living" is
// not English; "in the living room" is.
const ROOM_WORDS = {
  living: 'living room', bedroom: 'bedroom', kitchen: 'kitchen',
  bathroom: 'bathroom', dining: 'dining room', office: 'study',
};

async function raiseLeftBehind(user, itemId, s, room) {
  const dedup_key = `${user._id}:leftbehind:${itemId}:${Math.floor(+s.at / 1000)}`;
  const w = itemWords(s.name);
  const where = room ? ` in the ${ROOM_WORDS[room] || room}` : ' where you were';
  return record(user, 'left_behind', dedup_key, 'info',
    `You left your ${w.name} behind`,
    `Your ${w.name} ${w.were} put down${where} at ${timeWords(s.at)} and ` +
    `${w.they === 'they' ? 'have' : 'has'} not been in view since. ` +
    `${w.they === 'they' ? 'They' : 'It'} should still be there.`,
    { item_id: itemId, item_name: s.name, room, last_seen_at: s.at,
      keyframe_id: s.keyframe_id });
}

async function checkHabitualItems(user, profile, now = new Date()) {
  if (!isWakingHours(now)) return [];
  const out = [];
  for (const sig of profile.signals || []) {
    if (!sig.key.startsWith('item:')) continue;
    const exp = expectation(profile, sig.key, now);
    if (exp.insufficient || !exp.expected) continue;
    const itemId = sig.key.slice('item:'.length);
    const seen = await EventLog.exists({
      user_id: { $in: idForms(user._id) }, event_type: 'object',
      'details.items.enrolled_item_id': itemId, timestamp: { $gte: hoursAgo(DEVIATION_GRACE_HOURS, now), $lte: now },
    });
    if (seen) continue;
    const usualRoom = Object.entries(sig.rooms || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    const dedup_key = `${user._id}:habitual:${itemId}:${dayKey(now)}:${now.getHours()}`;
    const w = itemWords(sig.label);
    const f = await record(user, 'habitual_item', dedup_key, 'info',
      `Got your ${w.name}?`,
      `You usually have your ${w.name} with you around now` +
      (usualRoom ? `. ${w.they === 'they' ? "They're" : "It's"} most often in the ${usualRoom}.` : '.'),
      { signal: sig.key, ratio: exp.ratio, usual_room: usualRoom });
    if (f) out.push(f);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Outdoor item tracking (both roles)
// ═══════════════════════════════════════════════════════════════════════════

async function checkOutdoorItemLost(user, now = new Date()) {
  const { outdoorStatus, haversineM } = require('./outdoor');
  const status = await outdoorStatus(user, now);
  if (!status || !status.outdoors) return [];          // unknown or indoors: nothing to do
  const here = { lat: status.fix.lat, lng: status.fix.lng };

  // Last outdoor sighting of each enrolled item, with the GPS attached at the
  // moment of sighting (FE-13). Only sightings that carry a location count:
  // without one there is nowhere to point the wearer back to.
  const sightings = await EventLog.find({
    user_id: { $in: idForms(user._id) }, event_type: 'object',
    timestamp: { $gte: hoursAgo(ITEM_LOST_LOOKBACK_HOURS, now), $lte: now },
    'location.lat': { $exists: true },
  }).sort({ timestamp: -1 }).lean();

  // Keyed by STRING, for the same reason as checkLeftBehind above: an ObjectId
  // key is compared by reference, so the newest-wins rule silently inverted and
  // the oldest sighting was the one reported.
  const lastSeen = new Map();   // itemId -> {name, at, where, keyframe_id}
  for (const ev of sightings) {
    for (const it of (ev.details?.items || [])) {
      if (!it.enrolled_item_id || !it.matched_item
          || lastSeen.has(String(it.enrolled_item_id))) continue;
      lastSeen.set(String(it.enrolled_item_id), {
        name: it.matched_item, at: new Date(ev.timestamp),
        where: { lat: ev.location.lat, lng: ev.location.lng }, keyframe_id: ev.keyframe_id,
      });
    }
  }

  const out = [];
  for (const [itemId, s] of lastSeen) {
    // Was that sighting itself outdoors? A sighting at home followed by a walk
    // is the wearer carrying it out, not leaving it behind.
    if (user.home_location && haversineM(user.home_location, s.where) <= require('./outdoor').HOME_RADIUS_M) continue;
    const moved = haversineM(s.where, here);
    if (moved <= ITEM_LOST_MOVE_RADIUS_M) continue;
    const dedup_key = `${user._id}:itemlost:${itemId}:${Math.floor(+s.at / 1000)}`;
    const w = itemWords(s.name);
    const f = await record(user, 'item_lost', dedup_key, 'urgent',
      `Did you leave your ${w.name} behind?`,
      `Your ${w.name} ${w.were} last seen at ${timeWords(s.at)}, ${distanceWords(moved)} back the way you came, ` +
      `and ${w.they} ${w.have}n't been seen since. Worth a quick look back.`,
      { item_id: itemId, item_name: s.name, last_seen_at: s.at, last_seen_location: s.where,
        keyframe_id: s.keyframe_id, moved_m: Math.round(moved), current_location: here });
    if (f) out.push(f);
  }
  return out;
}

/**
 * FE-15. For item_lost findings older than ITEM_LOST_ESCALATE_MIN whose user
 * notification has not been acknowledged, tell the caregivers, with the
 * last-seen GPS, keyframe and timestamp. Returns the findings escalated.
 */
async function escalateUnacknowledgedItemLoss(user, now = new Date()) {
  if (!user.caregiver_ids || !user.caregiver_ids.length) return [];
  const Notification = require('../models/Notification');
  const stale = await RoutineFinding.find({
    user_id: user._id, kind: 'item_lost', escalated: false, notified: true,
    createdAt: { $lte: minutesAgo(ITEM_LOST_ESCALATE_MIN, now) },
  }).lean();
  const out = [];
  for (const f of stale) {
    const acked = await Notification.exists({ _id: { $in: f.notification_ids || [] }, acknowledged_at: { $ne: null } });
    if (acked) {
      await RoutineFinding.findByIdAndUpdate(f._id, { $set: { escalated: true, escalated_at: now } }); // resolved by user; close it
      continue;
    }
    const { deliverEscalation } = require('./routineNotifier');
    await deliverEscalation(f, user, now);
    await RoutineFinding.findByIdAndUpdate(f._id, { $set: { escalated: true, escalated_at: now } });
    out.push(f);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════

let lastRunAt = new Date(Date.now() - MONITOR_INTERVAL_MS);

async function runOnce(now = new Date()) {
  const User = require('../models/User');
  const sinceRun = lastRunAt;
  lastRunAt = now;
  const users = await User.find({ role: { $in: ['user', 'elderly'] } }).lean();
  const findings = [];
  for (const user of users) {
    try {
      const profile = await RoutineProfile.findOne({ user_id: user._id }).lean();
      if (user.role === 'elderly') {
        const a = await checkMedicationGap(user, now);           if (a) findings.push(a);
        const b = await checkInactivityAndCamera(user, now);     if (b) findings.push(b);
        if (profile) findings.push(...await checkDeviation(user, profile, now));
      } else {
        findings.push(...await checkLeftBehind(user, sinceRun, now));
        if (profile) findings.push(...await checkHabitualItems(user, profile, now));
      }
      // Outdoor item tracking applies to both roles: a lost wallet is a lost
      // wallet. Escalation only has somewhere to go when caregivers exist.
      findings.push(...await checkOutdoorItemLost(user, now));
      await escalateUnacknowledgedItemLoss(user, now);
    } catch (e) {
      console.error(`[RoutineMonitor] ${user.name}: ${e.message}`);
    }
  }
  if (findings.length) {
    console.log(`[RoutineMonitor] ${findings.length} new finding(s): ` +
      findings.map(f => `${f.kind}(${f.severity})`).join(', '));
    const { deliverFindings } = require('./routineNotifier');
    await deliverFindings(findings).catch(e => console.error('[RoutineMonitor] delivery failed:', e.message));
  }
  return findings;
}

function init() {
  console.log(`[RoutineMonitor] active — every ${MONITOR_INTERVAL_MS / 60000} min; ` +
    `med gap ${MED_GAP_DAYS}d, inactivity ${INACTIVITY_HOURS}h @ motion<${MOTION_FLOOR}, camera-off ${CAMERA_OFF_HOURS}h`);
  const pass = () => runOnce().catch(e => console.error('[RoutineMonitor]', e.message));
  // setInterval alone means the first pass is a whole interval away, so a
  // restart left anything already overdue unreported until then, and a restart
  // is exactly when something is most likely to be waiting. Run once now.
  pass();
  setInterval(pass, MONITOR_INTERVAL_MS);
}

module.exports = {
  init, runOnce,
  checkMedicationGap, checkInactivityAndCamera, checkDeviation, checkLeftBehind, checkHabitualItems,
  checkOutdoorItemLost, escalateUnacknowledgedItemLoss,
  MED_GAP_DAYS, INACTIVITY_HOURS, MOTION_FLOOR, STREAM_ALIVE_MIN, CAMERA_OFF_HOURS, LEFT_BEHIND_WINDOW_MIN,
  ITEM_LOST_MOVE_RADIUS_M, ITEM_LOST_ESCALATE_MIN, LEFT_BEHIND_AFTER_MIN, ITEM_GONE_MIN,
};
