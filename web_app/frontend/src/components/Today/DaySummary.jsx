import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Siren, Home, MapPin, Package, Users, Pill,
  MessageSquare, CalendarClock, Images, ChevronRight, Clock,
  Camera, CameraOff, Activity,
} from 'lucide-react';
import api, {
  eventLogsAPI, userItemsAPI, medicationAPI, notificationAPI, detectionAPI,
} from '../../services/api';
import { formatClockTime, formatSmartDate } from '../../utils/dateUtils';
import Loading from '../Feedback/Loading';
import { NO_DATA, NO_DATA_LABEL } from '../../utils/adherence';

/**
 * The whole day, on one page.
 *
 * WHAT THIS REPLACED
 *
 * Both main pages were medication readouts. The caregiver's computed
 * avgAdherence, missedDoses, skippedDoses and takenDoses, and its one-line
 * headline could only ever say something about doses -- "Every dose has been
 * taken", "Margaret has 2 doses not taken". A system that watches rooms,
 * belongings, faces, movement and location reported none of it. Medication is
 * now one small card among nine.
 *
 * WHAT IS NOT INVENTED
 *
 * Every figure here comes from an endpoint that already existed:
 *
 *   GET /event-logs/timeline      the day's events, routine findings, insights
 *   GET /user-items/last-seen     each belonging and where it was last seen
 *   GET /location/latest          the last GPS fix
 *   GET /medications/schedule/today   the next dose
 *   GET /notifications            alerts, and the routine_* findings
 *
 * Three deliberate absences:
 *
 *   Conversations has no endpoint and no model -- the Message collection is
 *   caregiver chat, not conversation summaries -- so the card says so rather
 *   than filling itself with plausible text.
 *
 *   "Left behind" is not computed here. It is read from notifications of type
 *   routine_left_behind / routine_item_lost, which the backend raises against
 *   a real baseline. Guessing it from a stale timestamp would flag a phone
 *   that is simply sitting on a desk.
 *
 *   Where the timeline's insights return value: null, the sentence it supplies
 *   is printed instead of a number. 0% claims the camera watched and saw
 *   nothing; null admits we cannot tell that from a camera that was off.
 */

/* One glyph per kind of event, so the rail can be read without the words.
   Keys are the `kind` values GET /event-logs/timeline emits. */
const KIND_ICON = {
  routine:    Home,
  activity:   Activity,
  medication: Pill,
  social:     Users,
  items:      Package,
  moment:     Camera,
  anomaly:    AlertTriangle,
};

const ROUTINE_TYPES = [
  'routine_medication_gap', 'routine_inactivity', 'routine_camera_off',
  'routine_deviation', 'routine_habitual_item',
];
const LEFT_BEHIND_TYPES = [
  'routine_left_behind', 'routine_item_lost', 'routine_item_lost_escalated',
];
const EMERGENCY_TYPES = ['emergency'];

const firstName = (n) => (n || '').trim().split(' ')[0];

/** A card with nothing in it still has to say what it is for. */
function CardEmpty({ icon: Glyph, children, action, to, tone }) {
  return (
    <div className={`card-empty${tone ? ` is-${tone}` : ''}`}>
      <span className="card-empty-disc" aria-hidden="true"><Glyph size={20} /></span>
      <p>{children}</p>
      {action && to && <Link to={to} className="card-empty-action">{action}</Link>}
    </div>
  );
}

/** Local clock, so it matches the day the rest of the page is describing. */
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Metres between two fixes. Enough for "is this the home address". */
function metresBetween(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const HOME_RADIUS_M = 150;   // the same radius item_indexer uses for "at home"
// A fix nobody has refreshed is not a place somebody IS. The threshold is the
// backend's own: item_indexer.OUTDOOR_MAX_FIX_AGE_MIN, which is how long that
// code will trust a fix before it stops deciding anything from it.
const FIX_MAX_AGE_MIN = 10;

export default function DaySummary({ userId, name, homeLocation, canAct = false, self = false }) {
  const [day, setDay] = useState(null);
  const [items, setItems] = useState([]);
  const [fix, setFix] = useState(null);
  // Judged when the reading arrives rather than during render: Date.now() in
  // render is impure, and "is this fresh" is a question about the moment the
  // data was read, which is the only moment it can honestly be answered.
  const [fixStale, setFixStale] = useState(true);
  const [schedule, setSchedule] = useState([]);
  const [notices, setNotices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      setLoading(true);
      // Settled, not all: one dead endpoint must not blank the whole page.
      const [t, b, l, s, n] = await Promise.allSettled([
        eventLogsAPI.timeline(userId ? { userId } : {}),
        userItemsAPI.lastSeenAll(userId),
        api.get('/location/latest' + (userId ? `?user_id=${userId}` : '')),
        medicationAPI.getSchedule(userId),
        notificationAPI.getAll({ limit: 25 }),
      ]);
      if (!alive) return;
      setDay(t.status === 'fulfilled' ? t.value.data : null);
      setItems(b.status === 'fulfilled' ? (b.value.data?.items || []) : []);
      const theFix = l.status === 'fulfilled' ? l.value.data : null;
      setFix(theFix);
      setFixStale(!theFix?.timestamp
        || (Date.now() - new Date(theFix.timestamp)) > FIX_MAX_AGE_MIN * 60000);
      setSchedule(s.status === 'fulfilled' ? (s.value.data || []) : []);
      setNotices(n.status === 'fulfilled' ? (n.value.data?.notifications || []) : []);
      setLoading(false);
    };

    load();
    return () => { alive = false; };
  }, [userId]);

  // The existing endpoint, and the banner reflects the result straight away
  // rather than waiting for the next mount.
  const markAllRead = async () => {
    try {
      await notificationAPI.markAllRead();
      setNotices(ns => ns.map(n => ({ ...n, is_read: true })));
    } catch {
      // Leave the banner up. Silently hiding an alert we failed to clear
      // would be the one outcome worse than the alert staying.
    }
  };

  const who = name ? firstName(name) : null;

  // ── Derived, all from the payloads above ────────────────────────────────
  // Memoised because peopleToday depends on it: `day?.items || []` makes a
  // fresh array every render, which would defeat that useMemo entirely.
  const timeline = useMemo(() => day?.items || [], [day]);
  const summary = day?.summary || {};
  const insights = day?.insights || [];
  // Memoised for the same reason timeline is: `day?.anomalies || []` makes a
  // fresh array every render, which would defeat the findings useMemo below.
  const findingsFromTimeline = useMemo(() => day?.anomalies || [], [day]);

  // /notifications returns everything addressed to the signed-in caregiver,
  // which on a per-person page includes alerts about OTHER people. Each row
  // carries subject_user_id (set by utils/notifications.js and
  // routes/caregiver.js), so scoping is a filter here rather than a backend
  // change. Unscoped -- the wearer's own page -- every notification is theirs.
  const scoped = useMemo(() => (
    userId
      ? notices.filter(n => String(n.subject_user_id || '') === String(userId))
      : notices
  ), [notices, userId]);

  const unread = useMemo(() => scoped.filter(n => !n.is_read), [scoped]);
  const emergency = unread.filter(n => EMERGENCY_TYPES.includes(n.type));
  const routineNotices = useMemo(
    () => unread.filter(n => ROUTINE_TYPES.includes(n.type)), [unread]);
  const leftBehind = useMemo(
    () => unread.filter(n => LEFT_BEHIND_TYPES.includes(n.type)), [unread]);

  const peopleToday = useMemo(() => {
    const names = timeline.filter(i => i.kind === 'social').map(i => i.title);
    return [...new Set(names)];
  }, [timeline]);

  // An insight with value null is one the endpoint could not compute. If
  // every one of them is null there is no baseline at all, and a grid of four
  // dashes says less than one sentence does.
  const measured = insights.filter(i => i.value !== null);
  const hasBaseline = measured.length > 0;
  // A routine finding reaches this page twice -- once as a timeline anomaly
  // and once as the notification raised from it -- so the same sentence was
  // printed twice. Matched on the title, which is what the reader compares.
  const findings = useMemo(() => {
    const out = [];
    const seen = new Set();
    // Keyed on the TITLE alone. The timeline carries a detail the
    // notification does not, so keying on the whole sentence let the same
    // finding through twice, differing only by its trailing clause.
    const add = (key, title, detail) => {
      const k = (title || '').trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ key, text: detail ? `${title} — ${detail}` : title });
    };
    findingsFromTimeline.forEach((f, i) => add(`t${i}`, f.title, f.detail));
    routineNotices.forEach(n => add(n._id, n.title));
    return out;
  }, [findingsFromTimeline, routineNotices]);

  const hasFindings = findings.length > 0;

  // The coverage measure returns null when the system cannot tell a camera
  // that saw nothing from a camera that was off, so "no frames today" is only
  // stated when it CAN tell.
  const coverageKnown = insights.some(i => i.key === 'coverage' && i.value !== null);

  const lastRoom = (summary.rooms || []).slice(-1)[0] || null;
  const lastEvent = timeline.length ? timeline[timeline.length - 1] : null;

  const nextDose = useMemo(() => {
    const pending = (schedule || [])
      .filter(s => s.status === 'scheduled' || s.status === 'snoozed')
      .sort((a, b) => new Date(a.scheduled_time) - new Date(b.scheduled_time));
    return pending[0] || null;
  }, [schedule]);

  const away = useMemo(() => {
    // No home address, or a reading too old to mean anything now.
    if (!fix?.lat || !homeLocation?.lat || fixStale) return null;
    return metresBetween(fix, homeLocation) > HOME_RADIUS_M;
  }, [fix, homeLocation, fixStale]);

  // One sentence about the day, and it is about the DAY -- not about doses.
  const statusLine = (() => {
    if (emergency.length) return 'An emergency alert is active.';
    if (unread.length) {
      return `${unread.length} ${unread.length === 1 ? 'alert needs' : 'alerts need'} a look.`;
    }
    if (!timeline.length) return 'Nothing has been recorded yet today.';
    const bits = [];
    if (summary.rooms?.length) bits.push(`${summary.rooms.length} ${summary.rooms.length === 1 ? 'room' : 'rooms'}`);
    if (summary.activities) bits.push(`${summary.activities} ${summary.activities === 1 ? 'activity' : 'activities'}`);
    if (summary.social) bits.push(`${summary.social} ${summary.social === 1 ? 'person' : 'people'}`);
    return bits.length ? `All calm — ${bits.join(', ')} so far.` : 'All calm.';
  })();

  if (loading) return <Loading rows={6} label="Loading the day" />;

  return (
    <div className="bento">
      {/* ── Alerts, pinned ─────────────────────────────────────────────── */}
      {/* Was a whole-banner link whose only affordance was a chevron, so the
          one thing you could do with an alert was leave the page. The actions
          are named now, and they are the ones that already exist. */}
      {unread.length > 0 && (
        <section
          className={`bento-banner${emergency.length ? ' is-emergency' : ''}`}
          role={emergency.length ? 'alert' : 'status'}
        >
          <span className="bento-banner-icon" aria-hidden="true">
            {emergency.length ? <Siren size={20} /> : <AlertTriangle size={20} />}
          </span>

          <span className="bento-banner-text">
            <strong>
              {emergency.length
                ? 'Emergency alert active'
                : `${unread.length} unacknowledged ${unread.length === 1 ? 'alert' : 'alerts'}`}
            </strong>
            <span className="bento-banner-sub">
              {(emergency[0] || unread[0])?.title}
            </span>
          </span>

          <span className="bento-banner-actions">
            <Link to="/notifications" className="btn btn-sm banner-review">Review</Link>
            {/* Not offered during an emergency: an SOS is not something to be
                cleared from a summary strip. */}
            {!emergency.length && (
              <button className="btn btn-sm banner-dismiss" onClick={markAllRead}>
                Mark all read
              </button>
            )}
          </span>
        </section>
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      {/* Was four stacked grey lines. Each pill below appears only when the
          data behind it exists -- an absent camera, room or fix shows no pill
          rather than a pill reading "unknown". */}
      <section className="bento-head">
        <p className="bento-date">
          {new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>

        <div className="bento-identity">
          <span className="bento-avatar" aria-hidden="true">
            {(name || '?').charAt(0).toUpperCase()}
          </span>
          <div>
            <h2 className="bento-greeting">
              {self ? `${greeting()}${who ? `, ${who}` : ''}` : (who ? `${who}'s day` : 'Your day')}
            </h2>
            <p className="bento-status">{statusLine}</p>
          </div>
        </div>

        <ul className="pill-row">
          {/* Not a live camera state -- nothing reports one. This is what was
              observed today, which is a fact the timeline already rests on. */}
          {summary.tracked_minutes > 0 ? (
            <li className="pill is-on">
              <Camera size={14} aria-hidden="true" />
              Camera recorded {Math.round(summary.tracked_minutes / 60) >= 1
                ? `${Math.round(summary.tracked_minutes / 60)}h today`
                : `${Math.round(summary.tracked_minutes)} min today`}
            </li>
          ) : coverageKnown && (
            <li className="pill is-off">
              <CameraOff size={14} aria-hidden="true" />
              No frames recorded today
            </li>
          )}

          {lastRoom && (
            <li className="pill">
              <Home size={14} aria-hidden="true" />
              Last in the {titleCase(lastRoom)}
              {lastEvent && <span className="pill-sub">{formatClockTime(lastEvent.at)}</span>}
            </li>
          )}

          {away !== null && (
            <li className={`pill ${away ? 'is-away' : 'is-on'}`}>
              <MapPin size={14} aria-hidden="true" />
              {away ? 'Away' : 'At home'}
              {fix?.timestamp && <span className="pill-sub">{formatSmartDate(fix.timestamp)}</span>}
            </li>
          )}

          {unread.length > 0 && (
            <li className="pill is-alert">
              <AlertTriangle size={14} aria-hidden="true" />
              {unread.length} {unread.length === 1 ? 'alert' : 'alerts'}
            </li>
          )}
        </ul>
      </section>

      {/* ── Day timeline: the hero ─────────────────────────────────────── */}
      <section className="bento-card is-wide">
        <header className="bento-card-head">
          <h3><span className="card-chip"><CalendarClock size={15} aria-hidden="true" /></span> Today</h3>
          <Link to="/activity">Full feed <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {timeline.length === 0 ? (
          /* A ghost of the thing that will be here, rather than a shrug. The
             rail and four muted nodes show the SHAPE of a day, so an empty
             page still explains what this card is for. */
          <div className="day-ghost">
            <ol className="day-line is-ghost" aria-hidden="true">
              {[0, 1, 2, 3].map(i => (
                <li key={i}>
                  <time />
                  <span className="day-line-node" />
                  <span className="day-line-card">
                    <span className="ghost-bar" style={{ width: `${68 - i * 9}%` }} />
                    <span className="ghost-bar is-short" style={{ width: `${40 - i * 5}%` }} />
                  </span>
                </li>
              ))}
            </ol>
            <p className="day-ghost-line">
              Rooms, people and belongings appear here as the camera recognises
              them through the day.
            </p>
          </div>
        ) : (
          <ol className="day-line">
            {timeline.slice(-9).reverse().map((e, i) => {
              const Glyph = KIND_ICON[e.kind] || CalendarClock;
              return (
                <li key={`${e.at}-${i}`} className={`is-${e.kind}`}>
                  <time>{formatClockTime(e.at)}</time>
                  <span className="day-line-node" aria-hidden="true">
                    <Glyph size={13} />
                  </span>
                  <span className="day-line-card">
                    {e.keyframe_id && (
                      <img
                        className="day-line-thumb"
                        src={detectionAPI.getKeyframeImage(e.keyframe_id, 160)}
                        alt=""
                        loading="lazy"
                        onError={ev => { ev.target.style.display = 'none'; }}
                      />
                    )}
                    <span className="day-line-text">
                      <span className="day-line-title">{e.title}</span>
                      {e.detail && <span className="day-line-detail">{e.detail}</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ── Routine ────────────────────────────────────────────────────── */}
      <section className="bento-card">
        <header className="bento-card-head">
          <h3><span className="card-chip"><CalendarClock size={15} aria-hidden="true" /></span> Routine</h3>
          <Link to="/routine">Open <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {!hasFindings ? (
          <p className="bento-quiet">
            {hasBaseline
              ? <>Nothing unusual against {who ? `${who}'s` : 'your'} usual pattern.</>
              : <>Still learning this routine — there is not enough history yet to
                 say what usual looks like for {who || 'you'}.</>}
          </p>
        ) : (
          <ul className="bento-list">
            {findings.slice(0, 4).map(f => (
              <li key={f.key}>
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Only once something is measurable. A dash is an answer; four of
            them in a grid is a broken-looking table. */}
        {hasBaseline && (
          <dl className="bento-figures">
            {insights.map(ins => (
              <div key={ins.key}>
                <dt>{ins.label}</dt>
                <dd>
                  {ins.value === null
                    ? <span className="bento-unknown" title={NO_DATA_LABEL}>
                        {NO_DATA}<span className="sr-only"> {NO_DATA_LABEL}</span>
                      </span>
                    : <span className="bento-value">{ins.value}%</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* ── Belongings ─────────────────────────────────────────────────── */}
      <section className="bento-card">
        <header className="bento-card-head">
          <h3><span className="card-chip"><Package size={15} aria-hidden="true" /></span> Belongings</h3>
          <Link to="/belongings">Open <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {/* Raised by the backend against a real baseline, not inferred here. */}
        {leftBehind.length > 0 && (
          <p className="bento-flag">
            <AlertTriangle size={14} aria-hidden="true" />
            {leftBehind[0].title}
          </p>
        )}

        {items.length === 0 ? (
          <CardEmpty icon={Package} action="Enrol an item" to="/belongings">
            Nothing enrolled yet. Once an item is enrolled, this shows where it
            was last seen.
          </CardEmpty>
        ) : (
          <ul className="bento-list">
            {items.slice(0, 4).map(it => (
              <li key={it.item_id}>
                <Package size={14} aria-hidden="true" />
                <span>
                  <strong>{it.name}</strong>
                  <span className="bento-sub">
                    {it.placement ? `${titleCase(it.placement)} · ` : ''}
                    {formatSmartDate(it.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── People ─────────────────────────────────────────────────────── */}
      <section className="bento-card">
        <header className="bento-card-head">
          <h3><span className="card-chip"><Users size={15} aria-hidden="true" /></span> People</h3>
          <Link to="/relationships">Open <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {peopleToday.length === 0 ? (
          <CardEmpty icon={Users}>
            Nobody has been recognised today.
          </CardEmpty>
        ) : (
          <ul className="bento-list">
            {peopleToday.slice(0, 4).map((p, i) => (
              <li key={i}><Users size={14} aria-hidden="true" /><span>{p}</span></li>
            ))}
          </ul>
        )}

        <Link to="/keyframes" className="bento-action">
          <Images size={14} aria-hidden="true" />
          Review faces
        </Link>
      </section>

      {/* ── Conversations ──────────────────────────────────────────────── */}
      <section className="bento-card">
        <header className="bento-card-head">
          <h3><span className="card-chip"><MessageSquare size={15} aria-hidden="true" /></span> Conversations</h3>
        </header>
        {/* No endpoint exists for conversation summaries. Saying so is the
            honest card; inventing a summary would be the alternative. Drawn
            as "coming", not as "broken". */}
        <CardEmpty icon={MessageSquare} tone="soon">
          <span className="card-empty-badge">Coming soon</span>
          Summaries of the conversations the camera hears. People recognised
          today are under People.
        </CardEmpty>
      </section>

      {/* ── Location: the caregiver's view only ────────────────────────── */}
      {/* This linked to /location, which is CaregiverOnlyRoute, so a wearer
          who tapped Map was redirected straight back to this page. Where
          somebody is is a caregiver's question; nobody needs an app to place
          them in the room they are standing in. */}
      {canAct && (
      <section className="bento-card is-short">
        <header className="bento-card-head">
          <h3><span className="card-chip"><MapPin size={15} aria-hidden="true" /></span> Location</h3>
          <Link to="/location">Map <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {!fix?.lat ? (
          <CardEmpty icon={MapPin}>No location has been reported yet.</CardEmpty>
        ) : away === null ? (
          // No home address configured, so Home/Away cannot be claimed.
          <p className="bento-quiet">
            {fixStale
              ? <>Last placed {formatSmartDate(fix.timestamp)} — too long ago to say where they are now.</>
              : <>Last seen {formatSmartDate(fix.timestamp)}. No home address is set, so Home and Away cannot be told apart.</>}
            {' '}<Link to="/location">See it on the map</Link>
          </p>
        ) : (
          <p className="bento-chip-row">
            <span className={`bento-chip ${away ? 'is-away' : 'is-home'}`}>
              {away ? <MapPin size={14} aria-hidden="true" /> : <Home size={14} aria-hidden="true" />}
              {away ? 'Away' : 'Home'}
            </span>
            <span className="bento-sub">
              <Clock size={12} aria-hidden="true" /> {formatSmartDate(fix.timestamp)}
            </span>
          </p>
        )}
      </section>
      )}

      {/* ── Medication: one small card, deliberately ───────────────────── */}
      <section className="bento-card is-short">
        <header className="bento-card-head">
          <h3><span className="card-chip"><Pill size={15} aria-hidden="true" /></span> Next dose</h3>
          <Link to={canAct ? '/medications' : '/my-medications'}>
            Open <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </header>

        {!nextDose ? (
          <CardEmpty icon={Pill}>Nothing else is due today.</CardEmpty>
        ) : (
          <p className="bento-dose">
            <span className="bento-dose-name">{nextDose.medication_name}</span>
            <span className="bento-sub">
              {nextDose.dosage ? `${nextDose.dosage} · ` : ''}
              {formatClockTime(nextDose.scheduled_time)}
            </span>
            <span className={`badge badge-${nextDose.status === 'snoozed' ? 'warning' : 'info'}`}>
              {nextDose.status === 'snoozed' ? 'Snoozed' : 'Scheduled'}
            </span>
          </p>
        )}
      </section>
    </div>
  );
}
