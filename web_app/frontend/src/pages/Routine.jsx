import { useEffect, useState } from 'react';
import { CalendarClock, AlertTriangle, Home } from 'lucide-react';
import { eventLogsAPI } from '../services/api';
import { useSelectedUser } from '../context/SelectedUserContext';
import { useAuth } from '../context/AuthContext';
import { formatClockTime } from '../utils/dateUtils';
import PageHeader from '../components/Layout/PageHeader';
import Loading from '../components/Feedback/Loading';
import { isCaregiver } from '../components/Nav/navItems';
import { NO_DATA, NO_DATA_LABEL } from '../utils/adherence';

/**
 * What today looked like, and what the system has actually learned.
 *
 * THE TWO HALVES ARE DELIBERATELY NOT MIXED
 *
 * "Today's pattern" is observation: the room sessions and activity sessions
 * the camera recorded today, straight from GET /event-logs/timeline. It is NOT
 * a routine. One day is not a baseline, and drawing it as one would tell a
 * caregiver the system understands a person it has barely met.
 *
 * "Findings" is the only half that comes from learning. Those entries are
 * RoutineFinding rows -- written by routineLearner/routineMonitor against a
 * 30-day baseline -- surfaced through the same endpoint as `anomalies`.
 *
 * WHAT IS NOT SHOWN
 *
 * No progress bar towards a baseline, no "day 12 of 30", no percentage of
 * routine learned. No endpoint reports any of those, so every one of them
 * would be a number made up on this page. Where the API cannot tell us
 * something it returns `value: null` with a sentence explaining why, and that
 * sentence is what gets printed.
 */
export default function Routine() {
  const { user } = useAuth();
  const { selectedUser } = useSelectedUser() || {};
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const scopeId = isCaregiver(user) ? selectedUser?._id : undefined;

  useEffect(() => {
    let alive = true;

    const load = async () => {
      setLoading(true);
      try {
        const res = await eventLogsAPI.timeline(scopeId ? { userId: scopeId } : {});
        if (alive) setData(res.data);
      } catch {
        if (alive) setData(null);
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    return () => { alive = false; };
  }, [scopeId]);

  if (loading) return <Loading rows={5} label="Loading routine" />;

  const items = data?.items || [];
  const findings = data?.anomalies || [];
  const insights = data?.insights || [];
  // Room and activity sessions are the shape of a day. Doses, faces and item
  // sightings belong to their own pages.
  const pattern = items.filter(i => i.kind === 'routine' || i.kind === 'activity');
  // Null means the endpoint could not compute it. None measurable at all means
  // there is no baseline, and then a figure of any kind would be invented.
  const hasBaseline = insights.some(i => i.value !== null);

  const who = isCaregiver(user) ? (selectedUser?.name || 'this person') : 'you';

  return (
    <>
      <PageHeader
        title="Routine"
        description={`Today's pattern, and what LOCUS has learned about ${who === 'you' ? 'your' : `${who}'s`} normal`}
      />

      {/* Whose routine this is, said plainly and first.
          
          Every figure below -- the findings, the baseline measures, today's
          pattern -- is about ONE person, and the page named them only in the
          middle of the description sentence. A caregiver who looks after more
          than one person could read this whole screen without registering
          which of them it described, and the two readings are not
          interchangeable: "nothing unusual" about the wrong person is worse
          than no answer. The PersonSwitcher in the dock sets this; the banner
          states it. */}
      {isCaregiver(user) && (
        <div className={`routine-subject${selectedUser ? '' : ' is-empty'}`}>
          <span className="routine-subject-avatar" aria-hidden="true">
            {(selectedUser?.name || '?').trim().charAt(0).toUpperCase()}
          </span>
          <div className="routine-subject-text">
            <span className="routine-subject-label">Routine being monitored</span>
            <strong>{selectedUser?.name || 'No family member selected'}</strong>
          </div>
        </div>
      )}

      {/* ── What has been learned ───────────────────────────────────────── */}
      <section className="card mb-4">
        <div className="card-header">
          <div className="card-title">Findings</div>
          <div className="card-subtitle">From the 30-day baseline, not from today</div>
        </div>

        {findings.length === 0 ? (
          <div className="empty-state">
            <CalendarClock aria-hidden="true" />
            <h3>{hasBaseline ? 'Nothing unusual' : 'Still learning this routine'}</h3>
            <p>
              {hasBaseline
                ? <>Nothing has been flagged against {who === 'you' ? 'your' : `${who}'s`} usual
                   pattern today.</>
                : <>There is not enough history yet to say what usual looks like
                   for {who}. Findings appear once there is.</>}
            </p>
          </div>
        ) : (
          <ul className="finding-list">
            {findings.map((f, i) => (
              <li key={i}>
                <AlertTriangle size={16} aria-hidden="true" />
                <span>
                  <strong>{f.title}</strong>
                  {f.detail && <span className="finding-detail">{f.detail}</span>}
                </span>
                <time>{formatClockTime(f.at)}</time>
              </li>
            ))}
          </ul>
        )}

        {/* The four measures the endpoint computes. A null value means the
            system cannot tell -- printed as its own sentence rather than as a
            zero, because 0% and "we do not know" are different claims. */}
        {/* Only when at least one measure exists. The endpoint's own sentence
            is printed under each, including for the ones it could not do. */}
        {hasBaseline && (
          <dl className="insight-list">
            {insights.map(ins => (
              <div key={ins.key}>
                <dt>{ins.label}</dt>
                <dd>
                  {ins.value === null
                    ? <span className="insight-unknown" title={NO_DATA_LABEL}>
                        {NO_DATA}<span className="sr-only"> {NO_DATA_LABEL}</span>
                      </span>
                    : <span className="insight-value">{ins.value}%</span>}
                  <span className="insight-detail">{ins.detail}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* ── What happened today ─────────────────────────────────────────── */}
      <section className="card">
        <div className="card-header">
          <div className="card-title">Today's pattern</div>
          <div className="card-subtitle">Recorded today — observation, not a learned routine</div>
        </div>

        {pattern.length === 0 ? (
          <div className="empty-state">
            <Home aria-hidden="true" />
            <h3>Nothing recorded yet today</h3>
            <p>Room visits and activities appear here as the camera recognises them.</p>
          </div>
        ) : (
          <ol className="pattern-list">
            {pattern.map((p, i) => (
              <li key={i}>
                <time>{formatClockTime(p.at)}</time>
                <span className="pattern-title">{p.title}</span>
                {p.detail && <span className="pattern-detail">{p.detail}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
