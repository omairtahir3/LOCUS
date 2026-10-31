import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Siren, Home, MapPin, Package, Users, Pill,
  MessageSquare, CalendarClock, Images, ChevronRight, Clock,
} from 'lucide-react';
import api, {
  eventLogsAPI, userItemsAPI, medicationAPI, notificationAPI, detectionAPI,
} from '../../services/api';
import { formatClockTime, formatSmartDate } from '../../utils/dateUtils';
import Loading from '../Feedback/Loading';

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

const ROUTINE_TYPES = [
  'routine_medication_gap', 'routine_inactivity', 'routine_camera_off',
  'routine_deviation', 'routine_habitual_item',
];
const LEFT_BEHIND_TYPES = [
  'routine_left_behind', 'routine_item_lost', 'routine_item_lost_escalated',
];
const EMERGENCY_TYPES = ['emergency'];

const firstName = (n) => (n || '').trim().split(' ')[0];
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

export default function DaySummary({ userId, name, homeLocation, canAct = false }) {
  const [day, setDay] = useState(null);
  const [items, setItems] = useState([]);
  const [fix, setFix] = useState(null);
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
      setFix(l.status === 'fulfilled' ? l.value.data : null);
      setSchedule(s.status === 'fulfilled' ? (s.value.data || []) : []);
      setNotices(n.status === 'fulfilled' ? (n.value.data?.notifications || []) : []);
      setLoading(false);
    };

    load();
    return () => { alive = false; };
  }, [userId]);

  const who = name ? firstName(name) : null;

  // ── Derived, all from the payloads above ────────────────────────────────
  // Memoised because peopleToday depends on it: `day?.items || []` makes a
  // fresh array every render, which would defeat that useMemo entirely.
  const timeline = useMemo(() => day?.items || [], [day]);
  const summary = day?.summary || {};
  const insights = day?.insights || [];
  const findingsFromTimeline = day?.anomalies || [];

  const unread = useMemo(() => notices.filter(n => !n.is_read), [notices]);
  const emergency = unread.filter(n => EMERGENCY_TYPES.includes(n.type));
  const routineNotices = useMemo(
    () => unread.filter(n => ROUTINE_TYPES.includes(n.type)), [unread]);
  const leftBehind = useMemo(
    () => unread.filter(n => LEFT_BEHIND_TYPES.includes(n.type)), [unread]);

  const peopleToday = useMemo(() => {
    const names = timeline.filter(i => i.kind === 'social').map(i => i.title);
    return [...new Set(names)];
  }, [timeline]);

  const lastRoom = (summary.rooms || []).slice(-1)[0] || null;
  const lastEvent = timeline.length ? timeline[timeline.length - 1] : null;

  const nextDose = useMemo(() => {
    const pending = (schedule || [])
      .filter(s => s.status === 'scheduled' || s.status === 'snoozed')
      .sort((a, b) => new Date(a.scheduled_time) - new Date(b.scheduled_time));
    return pending[0] || null;
  }, [schedule]);

  const away = useMemo(() => {
    if (!fix?.lat || !homeLocation?.lat) return null;     // cannot tell
    return metresBetween(fix, homeLocation) > HOME_RADIUS_M;
  }, [fix, homeLocation]);

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
      {(emergency.length > 0 || unread.length > 0) && (
        <Link
          to="/notifications"
          className={`bento-banner${emergency.length ? ' is-emergency' : ''}`}
        >
          {emergency.length
            ? <Siren size={20} aria-hidden="true" />
            : <AlertTriangle size={20} aria-hidden="true" />}
          <span>
            <strong>
              {emergency.length
                ? 'Emergency alert active'
                : `${unread.length} unacknowledged ${unread.length === 1 ? 'alert' : 'alerts'}`}
            </strong>
            <span className="bento-banner-sub">
              {(emergency[0] || unread[0])?.title}
            </span>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <section className="bento-head">
        <p className="bento-date">
          {new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        <h2 className="bento-greeting">
          {who ? `${who}'s day` : 'Your day'}
        </h2>
        <p className="bento-status">{statusLine}</p>
        <p className="bento-where">
          {lastRoom
            ? <>Last seen in the <strong>{titleCase(lastRoom)}</strong></>
            : <>No room recognised yet today</>}
          {lastEvent && <> · {formatClockTime(lastEvent.at)}</>}
        </p>
      </section>

      {/* ── Day timeline: the hero ─────────────────────────────────────── */}
      <section className="bento-card is-wide">
        <header className="bento-card-head">
          <h3><CalendarClock size={16} aria-hidden="true" /> Today</h3>
          <Link to="/activity">Full feed <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {timeline.length === 0 ? (
          <div className="empty-state">
            <CalendarClock aria-hidden="true" />
            <h3>Nothing recorded yet</h3>
            <p>Rooms, activities, people and belongings appear here as they are recognised.</p>
          </div>
        ) : (
          <ol className="day-line">
            {timeline.slice(-9).reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className={`is-${e.kind}`}>
                <time>{formatClockTime(e.at)}</time>
                {e.keyframe_id ? (
                  <img
                    className="day-line-thumb"
                    src={detectionAPI.getKeyframeImage(e.keyframe_id, 160)}
                    alt=""
                    loading="lazy"
                    onError={ev => { ev.target.style.visibility = 'hidden'; }}
                  />
                ) : <span className="day-line-thumb is-blank" aria-hidden="true" />}
                <span className="day-line-text">
                  <span className="day-line-title">{e.title}</span>
                  {e.detail && <span className="day-line-detail">{e.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── Routine ────────────────────────────────────────────────────── */}
      <section className="bento-card">
        <header className="bento-card-head">
          <h3><CalendarClock size={16} aria-hidden="true" /> Routine</h3>
          <Link to="/routine">Open <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {findingsFromTimeline.length === 0 && routineNotices.length === 0 ? (
          <p className="bento-quiet">
            Still learning this routine. Nothing has been flagged against
            {who ? ` ${who}'s` : ' your'} usual pattern.
          </p>
        ) : (
          <ul className="bento-list">
            {findingsFromTimeline.slice(0, 3).map((f, i) => (
              <li key={`t${i}`}>
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{f.title}{f.detail ? ` — ${f.detail}` : ''}</span>
              </li>
            ))}
            {routineNotices.slice(0, 3).map(n => (
              <li key={n._id}>
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{n.title}</span>
              </li>
            ))}
          </ul>
        )}

        {insights.length > 0 && (
          <dl className="bento-figures">
            {insights.map(ins => (
              <div key={ins.key}>
                <dt>{ins.label}</dt>
                <dd>
                  {ins.value === null
                    ? <span className="bento-unknown">Not enough data</span>
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
          <h3><Package size={16} aria-hidden="true" /> Belongings</h3>
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
          <p className="bento-quiet">
            Nothing enrolled yet, or nothing seen recently. Enrol an item to have
            it tracked.
          </p>
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
          <h3><Users size={16} aria-hidden="true" /> People</h3>
          <Link to="/relationships">Open <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {peopleToday.length === 0 ? (
          <p className="bento-quiet">Nobody has been recognised today.</p>
        ) : (
          <ul className="bento-list">
            {peopleToday.slice(0, 4).map((p, i) => (
              <li key={i}><Users size={14} aria-hidden="true" /><span>{p}</span></li>
            ))}
          </ul>
        )}

        <Link to="/keyframes" className="bento-action">
          <Images size={14} aria-hidden="true" />
          Review recent keyframes
        </Link>
      </section>

      {/* ── Conversations ──────────────────────────────────────────────── */}
      <section className="bento-card">
        <header className="bento-card-head">
          <h3><MessageSquare size={16} aria-hidden="true" /> Conversations</h3>
        </header>
        {/* No endpoint exists for conversation summaries. Saying so is the
            honest card; inventing a summary would be the alternative. */}
        <div className="empty-state">
          <MessageSquare aria-hidden="true" />
          <h3>Not available yet</h3>
          <p>Conversation summaries are not part of this build. Recognised
             people appear under People.</p>
        </div>
      </section>

      {/* ── Location ───────────────────────────────────────────────────── */}
      <section className="bento-card is-short">
        <header className="bento-card-head">
          <h3><MapPin size={16} aria-hidden="true" /> Location</h3>
          <Link to="/location">Map <ChevronRight size={14} aria-hidden="true" /></Link>
        </header>

        {!fix?.lat ? (
          <p className="bento-quiet">No location reported yet.</p>
        ) : away === null ? (
          // No home address configured, so Home/Away cannot be claimed.
          <p className="bento-quiet">
            Last seen {formatSmartDate(fix.timestamp)}.{' '}
            <Link to="/location">See it on the map</Link>
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

      {/* ── Medication: one small card, deliberately ───────────────────── */}
      <section className="bento-card is-short">
        <header className="bento-card-head">
          <h3><Pill size={16} aria-hidden="true" /> Next dose</h3>
          <Link to={canAct ? '/medications' : '/my-medications'}>
            Open <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </header>

        {!nextDose ? (
          <p className="bento-quiet">Nothing else due today.</p>
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
