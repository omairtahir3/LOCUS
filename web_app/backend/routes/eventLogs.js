const express = require('express');
const router = express.Router();
const EventLog = require('../models/EventLog');
const { protect: auth } = require('../middleware/auth');

// POST /api/event-logs/ask
// Answers a question in the wearer's own words ("where did I last put my
// keys?"). The agent itself lives in utils/memoryAgent.js; this is only auth,
// the same caregiver resolution as memory-search, and the shape the page reads.
//
// answer === null means no LLM was reachable. The page falls back to the
// substring filter it used before rather than showing an error, because a
// typed search must keep working when a free-tier key is rate limited.
router.post('/ask', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      if (req.query.userId) {
        userId = req.query.userId;
      } else {
        const User = require('../models/User');
        const caregiver = await User.findById(req.user.id);
        if (caregiver?.monitoring_users && caregiver.monitoring_users.length > 0) {
          userId = caregiver.monitoring_users[0];
        }
      }
    }
    // A caregiver reading about someone else must not be told "you put your
    // keys down". The subject's name is looked up only when it is NOT the
    // person asking, so the ordinary case costs no extra query.
    let subjectName = null;
    if (String(userId) !== String(req.user.id)) {
      const User = require('../models/User');
      const subject = await User.findById(userId).select('name');
      subjectName = subject?.name || null;
    }
    const { ask } = require('../utils/memoryAgent');
    res.json(await ask(req.body?.question, userId, { subjectName }));
  } catch (error) {
    console.error('Error answering memory question:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/event-logs/memory-search
// Returns medication_intake, social_interaction and activity, excluding rejected
router.get('/memory-search', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    // If caregiver, they view logs for their connected elderly user
    if (req.user.role === 'caregiver') {
      if (req.query.userId) {
        userId = req.query.userId;
      } else {
        const User = require('../models/User');
        const caregiver = await User.findById(req.user.id);
        if (caregiver?.monitoring_users && caregiver.monitoring_users.length > 0) {
          userId = caregiver.monitoring_users[0];
        }
      }
    }

    const { type, limit, date, person, item } = req.query;

    // Same id-form problem as the timeline: some writers store user_id as a
    // string and others as an ObjectId, and matching only one form returns an
    // empty page rather than an error.
    const mongoose = require('mongoose');
    const idForms = [userId, String(userId)];
    if (mongoose.Types.ObjectId.isValid(userId)) idForms.push(new mongoose.Types.ObjectId(String(userId)));

    const query = {
      user_id: { $in: idForms },
      event_type: { $in: ['medication_intake', 'social_interaction', 'activity', 'object'] },
      // scene_change events share event_type 'activity' but are raw motion-burst
      // captures with no classification — they belong in Keyframe Audit, not a
      // memory timeline, where they render as meaningless "Activity detected".
      // camera_heartbeat is excluded for a different reason: it is liveness
      // bookkeeping written every minute with NO image, so it would flood the
      // day with entries that have nothing to show.
      //
      // 'coverage' is NOT excluded. It is the deliberate every-two-minutes
      // frame, captured precisely so a stretch where nothing was recognised
      // still leaves the person something to look at. A whole eight-minute
      // recording in the wearer's own bedroom produced no memory at all
      // because every frame it saved was filed as a raw motion burst.
      'details.action': { $nin: ['scene_change', 'camera_heartbeat'] },
      verification_status: { $ne: 'rejected' },
      // An unconfirmed dose is a question, not a memory. A needs_verification
      // detection appeared here as "Panadol, waiting for your confirmation",
      // which asserts the dose and disclaims it in the same line; one wearer
      // had already answered "not taken" and it was still listed. The record
      // stays in the database for the verification screen to act on. Other
      // event types are unaffected: only medication makes a claim that the
      // person is expected to confirm before it counts.
      $nor: [
        { event_type: 'medication_intake', verification_status: { $ne: 'confirmed' } },
        // A belonging memory that never had a picture.
        //
        // These are not memories, they are bookkeeping: the indexer had already
        // stored a frame of that belonging in that spot, so the second sighting
        // was recorded without one. On the page it drew an entry saying the
        // phone was spotted with nothing to show, which reads as a photograph
        // that failed to load.
        //
        // Written as "has no keyframe_id", which is different from "its picture
        // has since been deleted". A memory whose frame has passed its retention
        // window KEEPS its id and stays on the page; the page simply has nothing
        // to render for it. Only the ones that never had a frame are dropped.
        { event_type: 'object', keyframe_id: { $in: [null, ''] } },
        { event_type: 'object', keyframe_id: { $exists: false } },
        // An item in the wearer's own hand is not a memory of where they left
        // something, and `unknown` is the indexer saying it could not tell.
        // Neither has a picture any more either, so without this they appeared
        // here as a "Spotted Phone" row with nothing to show.
        //
        // Written as "has a non-placed item AND has no placed item", so a frame
        // that caught one thing put down and another in hand is still kept. The
        // $ne on an array field matches documents where NO element equals it,
        // which is the "none of them" this needs.
        //
        // Deliberately NOT "placement must be placed": 317 of 321 historical
        // sightings predate the field entirely, and requiring it would erase
        // every memory recorded before this was added.
        {
          event_type: 'object',
          'details.items.placement': { $in: ['in_hand', 'unknown'] },
          $and: [{ 'details.items.placement': { $ne: 'placed' } }],
        },
      ],
    };

    if (type && query.event_type.$in.includes(type)) {
      query.event_type = type; // override with specific filter
    }

    // ── Filtered by person, or by object (FE 6-3) ────────────────────────────
    //
    // The spec asks for search "filtered by date, person, or object". Date was
    // here; the other two were only reachable as a category -- "Social" gave
    // every person at once and "Belongings" every item -- so "when did I last
    // see Omair" could not be narrowed at all without asking the agent.
    //
    // Narrowing by one entity necessarily restricts the event type: only a face
    // event has a person and only an object event has a belonging. Set here
    // rather than left to the caller, so a request cannot ask for a person
    // among medication rows and quietly get nothing.
    if (person) {
      if (!mongoose.Types.ObjectId.isValid(String(person))) {
        return res.status(400).json({ error: 'person must be a relationship id' });
      }
      query.person_id = new mongoose.Types.ObjectId(String(person));
      query.event_type = 'social_interaction';
    }
    if (item) {
      if (!mongoose.Types.ObjectId.isValid(String(item))) {
        return res.status(400).json({ error: 'item must be a belonging id' });
      }
      // Stored as a string on the event, so matched as one. The $nor above
      // still applies, so a sighting with no picture or one in the wearer's
      // hand stays excluded for this item exactly as for any other.
      query['details.items.enrolled_item_id'] = String(item);
      query.event_type = 'object';
    }

    // A day at a time, bounded by the LOCAL day so "the 24th" means the same
    // thing to the person reading it as to their clock. Without a date this
    // still returns the most recent events, as it always did.
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      const [y, mo, d] = date.split('-').map(Number);
      const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      query.timestamp = { $gte: start, $lt: end };
    }

    // When a day is asked for, everything that happened that day is returned:
    // a memory aid that hides the afternoon behind a page-50 cut-off is not
    // answering the question. The cap is only a guard against an
    // unbounded payload, and is far above any real day (the busiest on record
    // here is 264 events).
    const HARD_CAP = 5000;
    const cap = limit ? Math.min(Number(limit) || HARD_CAP, HARD_CAP) : (date ? HARD_CAP : 200);

    const events = await EventLog.find(query)
      // Name and relationship only. This also asked for face_embedding, which
      // is a 512-float biometric template: no client reads it, the timeline
      // route next door never sent it, and a page of memories was shipping one
      // per recognised face to the browser. A day with 264 events would send
      // one for every row of them.
      .populate('person_id', 'person_name relationship_type')
      .sort({ timestamp: -1 })
      .limit(cap);

    res.json(events);
  } catch (error) {
    console.error('Error fetching memory search logs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/** Steps that count as a full day's walking. Overridable per deployment. */
const STEP_GOAL = Number(process.env.DAILY_STEP_GOAL || 5000);
/** Hours a camera would have to cover to call the day fully observed. */
const OBSERVABLE_HOURS = 14;   // roughly 08:00-22:00
const SOCIAL_BASELINE_DAYS = 14;

/**
 * The four Behavioural Insights bars.
 *
 * Every one is computed from something the system actually recorded. Where
 * there is no data the score is null and the UI says so, rather than showing a
 * plausible-looking bar. A care dashboard that invents a number is worse than
 * one that admits it does not know.
 *
 * Note on "Sleep Quality": LOCUS has no sleep sensor, no wearable and no
 * overnight camera guarantee, so it cannot be measured and is not shown.
 * Camera Coverage takes its place: how much of the day was actually observed,
 * which is the figure that tells a caregiver how much to trust the others.
 */
async function buildInsights({ idForms, start, end, items, anomalies, steps, minutesIndoors }) {
  const pct = (n, d) => (d > 0 ? Math.max(0, Math.min(100, Math.round((n / d) * 100))) : null);

  // ── Routine adherence: did the scheduled doses actually happen? ──────────
  const MedicationLog = require('../models/MedicationLog');
  const logs = await MedicationLog.find({
    user_id: { $in: idForms }, scheduled_time: { $gte: start, $lt: end },
  }).lean();
  const due = logs.filter(l => l.status !== 'scheduled');   // still pending is not yet a miss
  const taken = due.filter(l => l.status === 'taken' || l.taken_at);
  // A routine deviation (not in the usual room at the usual time) costs 10
  // points each, so adherence reflects more than medication alone.
  const deviations = anomalies.filter(a => a.finding_kind === 'deviation').length;
  let adherence = due.length ? pct(taken.length, due.length) : null;
  if (adherence !== null) adherence = Math.max(0, adherence - deviations * 10);

  // ── Social activity: today against this person's own normal ─────────────
  // Compared with themselves, not a population average: a quiet person having
  // a normal day should not read as a problem.
  const socialToday = items.filter(i => i.kind === 'social').length;
  const since = new Date(start); since.setDate(since.getDate() - SOCIAL_BASELINE_DAYS);
  const priorSocial = await EventLog.countDocuments({
    user_id: { $in: idForms },
    event_type: { $in: ['social_interaction', 'unknown_face'] },
    timestamp: { $gte: since, $lt: start },
  });
  const socialBaseline = priorSocial / SOCIAL_BASELINE_DAYS;
  const social = socialBaseline > 0 ? pct(socialToday, socialBaseline)
    : (socialToday > 0 ? 100 : null);

  // ── Physical activity: steps against the daily goal ─────────────────────
  const physical = steps == null ? null : pct(steps, STEP_GOAL);

  // ── Camera coverage: how much of the day was observed at all ────────────
  // Measured from liveness heartbeats, which are written every minute the
  // camera runs whether or not anything is recognised. Room sessions alone
  // understate this badly: a camera that ran all day in rooms it could not
  // name reported "no room sessions for this day", which reads as a dead
  // device. Heartbeats separate "not observed" from "observed, nothing named".
  const HEARTBEAT_MINUTES = 1;   // HEARTBEAT_SECONDS is 60 in the pipeline
  const beats = await EventLog.countDocuments({
    user_id: { $in: idForms }, 'details.action': 'camera_heartbeat',
    timestamp: { $gte: start, $lt: end },
  });
  const observedMinutes = Math.max(beats * HEARTBEAT_MINUTES, minutesIndoors);
  // Still null, not 0%, when nothing was observed: 0% asserts the camera was
  // running and saw nothing, and null admits we cannot tell that from off.
  const coverage = observedMinutes > 0 ? pct(observedMinutes, OBSERVABLE_HOURS * 60) : null;

  return [
    { key: 'routine', label: 'Routine Adherence', value: adherence,
      detail: due.length ? `${taken.length} of ${due.length} doses confirmed`
                         + (deviations ? `, ${deviations} routine deviation${deviations === 1 ? '' : 's'}` : '')
                         : 'No doses were due today' },
    { key: 'social', label: 'Social Activity', value: social,
      detail: socialBaseline > 0
        ? `${socialToday} today against a usual ${socialBaseline.toFixed(1)} a day`
        : (socialToday > 0 ? `${socialToday} today, no history to compare with yet`
                           : 'No interactions recorded, and no history to compare with') },
    { key: 'physical', label: 'Physical Activity', value: physical,
      detail: steps == null ? 'The phone has not reported steps for this day'
                            : `${steps.toLocaleString()} steps against a ${STEP_GOAL.toLocaleString()} goal` },
    { key: 'coverage', label: 'Camera Coverage', value: coverage,
      detail: observedMinutes
        ? `${Math.round(observedMinutes)} minutes observed of about ${OBSERVABLE_HOURS} waking hours`
          + (minutesIndoors > 0 ? `, ${Math.round(minutesIndoors)} in a recognised room` : '')
        : 'The camera did not record anything for this day' },
  ];
}

/**
 * GET /api/event-logs/timeline?date=YYYY-MM-DD&userId=
 *
 * One day of the Core Module's output, assembled for the Activity Feed:
 * environment sessions (FE-2), medication intakes (FE-4), social interactions
 * (FE-4), item sightings (FE-12/13) and routine findings as anomalies.
 *
 * Replaces the hard-coded mockActivities array the page used to render, which
 * showed a plausible-looking day ("Met with neighbor Mrs. Johnson", "~2,400
 * steps") that came from nowhere and never changed.
 */
router.get('/timeline', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      if (req.query.userId) userId = req.query.userId;
      else {
        const User = require('../models/User');
        const cg = await User.findById(req.user.id);
        if (cg?.monitoring_users?.length) userId = cg.monitoring_users[0];
      }
    }

    const day = req.query.date ? new Date(req.query.date) : new Date();
    if (Number.isNaN(day.getTime())) return res.status(400).json({ error: 'invalid date' });
    const start = new Date(day); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);

    const mongoose = require('mongoose');
    // Events are written with a string user id by some paths and an ObjectId by
    // others; match both rather than silently returning an empty day.
    const idForms = [userId, String(userId)];
    if (mongoose.Types.ObjectId.isValid(userId)) idForms.push(new mongoose.Types.ObjectId(String(userId)));

    // person_id is populated because the person's NAME lives on the
    // relationship, not on the event. Without it every recognised face read
    // "Someone familiar nearby" even when the wearer had named them, which is
    // the one detail that makes the entry worth anything.
    require('../models/Relationship');
    const events = await EventLog.find({
      user_id: { $in: idForms },
      timestamp: { $gte: start, $lt: end },
      verification_status: { $ne: 'rejected' },
      // scene_change is a raw motion burst with no classification; heartbeats
      // are once-a-minute liveness bookkeeping with no image. Neither is a
      // timeline entry, and a day holds ~1440 heartbeats, so excluding them
      // here keeps the payload to real events. Coverage counts them separately.
      'details.action': { $nin: ['scene_change', 'camera_heartbeat'] },
    }).populate('person_id', 'person_name relationship_type').sort({ timestamp: 1 }).lean();

    const RoutineFinding = require('../models/RoutineFinding');
    const findings = await RoutineFinding.find({
      user_id: { $in: idForms }, createdAt: { $gte: start, $lt: end },
    }).sort({ createdAt: 1 }).lean();

    const items = [];
    for (const e of events) {
      const d = e.details || {};
      if (e.event_type === 'activity' && d.action === 'scene_session') {
        const mins = Math.round((d.duration_seconds || 0) / 60);
        items.push({ at: e.timestamp, kind: 'routine',
          title: `${d.scene ? d.scene[0].toUpperCase() + d.scene.slice(1) : 'Room'} activity`,
          detail: mins ? `${mins} minute${mins === 1 ? '' : 's'}` : 'Brief visit',
          keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'activity' && d.action === 'coverage') {
        // A periodic frame from a stretch we could not name. Worth showing:
        // "nothing was recognised here" and "nothing happened here" are
        // different, and only one of them should look empty.
        items.push({ at: e.timestamp, kind: 'moment', title: 'A moment from the day',
          detail: 'No room or activity recognised', keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'activity' && d.action === 'activity_session') {
        // A confirmed stretch of one activity, not a guess about one frame.
        // Per-frame activity labels were removed because they hallucinated;
        // these are only written after the same activity is seen repeatedly
        // over a span of time (see ai/scene.py ActivitySessionTracker).
        const mins = Math.round((d.duration_seconds || 0) / 60);
        items.push({ at: e.timestamp, kind: 'activity',
          title: d.label || 'Activity',
          detail: mins ? `${mins} minute${mins === 1 ? '' : 's'}` : 'Briefly',
          confidence: e.confidence, keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'medication_intake') {
        // Only a CONFIRMED dose is a memory. A needs_verification detection is
        // a question the system is asking, not a thing that happened, and
        // showing it as "Panadol taken, waiting for your confirmation" states
        // the dose as fact in the same breath as admitting it is unverified.
        // The record still exists for the verification screen to act on; it
        // simply does not belong in a record of the day until somebody says so.
        if (e.verification_status !== 'confirmed') continue;
        items.push({ at: e.timestamp, kind: 'medication',
          title: d.medication_name ? `${d.medication_name} taken` : 'Medication taken',
          detail: 'Confirmed by the camera',
          confidence: e.confidence, keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'social_interaction') {
        // The name first, because the name is the memory. "Someone familiar
        // nearby" is what this said even for a face the wearer had themself
        // named Onais, which tells them strictly less than they already knew.
        const name = e.person_id?.person_name || d.person_name || d.person || null;
        const rel = e.person_id?.relationship_type || d.relationship_type || null;
        items.push({ at: e.timestamp, kind: 'social',
          title: name ? `You were with ${name}` : 'Someone you know was nearby',
          detail: name
            ? (rel ? `Your ${String(rel).toLowerCase()}` : 'A face you have named')
            : 'Recognised, but not yet named',
          person_name: name,
          keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'unknown_face') {
        items.push({ at: e.timestamp, kind: 'social', title: 'An unfamiliar face',
          detail: 'Not matched to anyone you know', keyframe_id: e.keyframe_id || null });
      } else if (e.event_type === 'object' && d.action === 'item_seen') {
        // An item in the wearer's own hand is not a memory of where they left
        // something, it is just them holding their phone, and "Spotted phone"
        // for every glance would bury the sightings that matter. The indexer
        // records held sightings because the routine monitor needs them to tell
        // "you carried it away" from "you left it" -- they are evidence, not
        // timeline entries.
        // Only what was actually PUT DOWN. in_hand is the wearer holding their
        // own phone, and unknown is the indexer saying it could not tell --
        // neither is a memory of where something was left, and showing either
        // as "Spotted" is the complaint this answers.
        // Drop what we KNOW is not a put-down, rather than requiring proof that
        // it is. 317 of 321 historical sightings carry no placement at all, and
        // demanding 'placed' would have erased every memory older than the
        // field itself.
        const notPutDown = (i) => ['in_hand', 'unknown'].includes(i.placement || d.placement);
        const recognised = (d.items || []).filter(i => i.matched_item);
        // The GATE is still "something was actually put down". A frame of the
        // wearer holding their own phone is not a memory of where anything was
        // left, and one per glance would bury the sightings that matter.
        if (!recognised.some(i => !notPutDown(i))) continue;

        // ── Every belonging in the frame gets named ──────────────────────────
        //
        // This listed only what was put DOWN, so a frame holding a phone on the
        // desk and earbuds in the wearer's hand was titled "Spotted Phone" and
        // the earbuds vanished -- the event row said two things, the timeline
        // said one, and the memory pages next door said two. Worse, the detail
        // line read off the frame-level placement, which is the string "mixed"
        // for exactly those frames, so the two entries that DID contain a
        // second belonging were the two labelled "Seen at home".
        //
        // Generic by construction: it reads each item's own placement, so it
        // behaves the same for any number of belongings and any mixture of
        // states, now and for anything enrolled later.
        const uniq = [...new Set(recognised.map(i => i.matched_item))];
        const where = e.location ? 'while out' : 'at home';

        // Grouped by what each one was doing, in the frame's own order.
        const stateOf = (i) => {
          const pl = i.placement || d.placement;
          if (pl === 'in_hand') return 'in your hand';
          if (pl === 'unknown') return 'also in view';
          // No placement at all: 317 of 321 historical sightings predate the
          // field, and calling those "unknown" would relabel the entire past.
          return `put down ${where}`;
        };
        const groups = new Map();
        for (const i of recognised) {
          const st = stateOf(i);
          if (!groups.has(st)) groups.set(st, new Set());
          groups.get(st).add(i.matched_item);
        }
        // One state, one phrase: "Put down at home", as before. Several, and
        // each is named, because that is the case the old line got wrong.
        let detail;
        if (groups.size === 1) {
          const st = [...groups.keys()][0];
          detail = st.startsWith('put down') ? `Put down ${where}`
            : st === 'in your hand' ? `In your hand` : `Seen ${where}`;
        } else {
          detail = [...groups.entries()]
            .map(([st, names]) => `${[...names].join(', ')} ${st}`)
            .join(' · ');
        }

        // A sighting, not a departure. "Left" belongs to the routine monitor's
        // left_behind finding, which knows the wearer moved away and the item
        // was not seen again; a single frame cannot know either.
        items.push({ at: e.timestamp, kind: 'items',
          title: `Spotted ${uniq.slice(0, 4).join(', ')}`
            + (uniq.length > 4 ? ` +${uniq.length - 4} more` : ''),
          detail,
          keyframe_id: e.keyframe_id || null });
      }
    }
    for (const f of findings) {
      items.push({ at: f.createdAt, kind: 'anomaly', title: f.title, detail: f.message,
        severity: f.severity, finding_kind: f.kind });
    }
    items.sort((a, b) => new Date(a.at) - new Date(b.at));

    // Summary counts, all derived -- nothing invented.
    const minutesIndoors = events
      .filter(e => e.details?.action === 'scene_session')
      .reduce((n, e) => n + (e.details.duration_seconds || 0), 0) / 60;

    // Steps come from the phone's pedometer, not from the camera, so they are
    // read from their own collection rather than derived from events. null
    // (not 0) when the phone has not reported: "no data" and "did not move"
    // are different answers and must not look the same on the dashboard.
    const StepCount = require('../models/StepCount');
    const localDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const stepDoc = await StepCount.findOne({ user_id: { $in: idForms }, date: localDate }).lean();

    // The anomalies again on their own, so the page can list them rather than
    // only count them. Same objects as the timeline entries.
    const anomalies = items.filter(i => i.kind === 'anomaly');

    const insights = await buildInsights({
      idForms, start, end, items, anomalies, steps: stepDoc ? stepDoc.steps : null, minutesIndoors,
    });

    res.json({
      date: localDate,
      items,
      anomalies,
      insights,
      summary: {
        medication: items.filter(i => i.kind === 'medication').length,
        social: items.filter(i => i.kind === 'social').length,
        items_seen: items.filter(i => i.kind === 'items').length,
        activities: items.filter(i => i.kind === 'activity').length,
        anomalies: anomalies.length,
        steps: stepDoc ? stepDoc.steps : null,
        tracked_minutes: Math.round(minutesIndoors),
        rooms: [...new Set(events.filter(e => e.details?.action === 'scene_session').map(e => e.details.scene).filter(Boolean))],
      },
    });
  } catch (error) {
    console.error('Error building activity timeline:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/event-logs/keyframes
// For Keyframe Audit screen (includes unknown_face and medication_intake)
router.get('/keyframes', auth, async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.user.role === 'caregiver') {
      const User = require('../models/User');
      const caregiver = await User.findById(req.user.id);
      if (caregiver.monitoring_users && caregiver.monitoring_users.length > 0) {
        userId = caregiver.monitoring_users[0];
      }
    }

    const { type, limit = 50 } = req.query;

    const query = {
      user_id: userId,
      event_type: { $in: ['medication_intake', 'unknown_face'] },
      verification_status: { $ne: 'rejected' }
    };

    if (type && query.event_type.$in.includes(type)) {
      query.event_type = type;
    }

    const events = await EventLog.find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit));

    res.json(events);
  } catch (error) {
    console.error('Error fetching keyframe logs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});
// PATCH /api/event-logs/:id/flag
// Universal endpoint to toggle the is_flagged state of any event (e.g. medication or social)
router.patch('/:id/flag', auth, async (req, res) => {
  try {
    const { is_flagged } = req.body;
    
    if (typeof is_flagged !== 'boolean') {
      return res.status(400).json({ error: 'is_flagged boolean is required' });
    }

    const eventId = req.params.id;
    const event = await EventLog.findById(eventId);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Role check: caregiver can only flag events for their connected user
    if (req.user.role === 'caregiver') {
      const User = require('../models/User');
      const caregiver = await User.findById(req.user.id);
      if (!caregiver.monitoring_users || !caregiver.monitoring_users.map(id => String(id)).includes(String(event.user_id))) {
        return res.status(403).json({ error: 'Unauthorized to flag this event' });
      }
    } else {
      if (String(event.user_id) !== String(req.user.id)) {
        return res.status(403).json({ error: 'Unauthorized to flag this event' });
      }
    }

    event.is_flagged = is_flagged;

    if (!is_flagged) {
      // If unflagging, and the frame is past 72 hours, remove it from the event
      // so the UI hides it immediately, and the Python backend deletes the orphaned file.
      const eventAgeHours = (Date.now() - new Date(event.timestamp).getTime()) / (1000 * 60 * 60);
      if (eventAgeHours > 72) {
        event.keyframe_id = null;
        if (event.keyframe_ref) {
          event.keyframe_ref = null;
        }
      }
    }

    await event.save();

    res.json(event);
  } catch (error) {
    console.error('Error toggling flag:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
