import { useMemo, useState } from 'react';

/**
 * Thirty days of a person's doses, one cell per day.
 *
 * WHY A STRIP AND NOT A PERCENTAGE BAR
 *
 * The dashboard reduced a month to a single number and a CSS div sized to it.
 * A caregiver reading "80%" cannot tell whether the missing fifth was doses the
 * wearer did not take or a camera that was not watching, and those call for
 * opposite responses: one is a care problem, the other is a coverage problem.
 * The backend already separates them -- adherence is taken / (taken + missed),
 * with camera_off deliberately outside the denominator -- and the interface
 * threw that distinction away. This puts it back.
 *
 * WHY THE GLYPH CARRIES THE MEANING AND THE COLOUR ONLY REINFORCES IT
 *
 * Measured, not assumed. The status palette's "taken" green (#0ca30c) and
 * "missed" red (#d03b3b) sit at
 *
 *     deutan dE 4.1
 *
 * which is far below the 6-8 floor where secondary encoding is merely advisable.
 * Taken-versus-missed is the single most important read on this page, and in
 * red/green it is close to invisible to a deuteranope -- roughly one man in
 * sixteen, and a caregiver is as likely to be one as anybody. So every cell
 * carries a mark that means the thing on its own: a tick, a cross, a question,
 * a dash. Remove all colour and the strip still reads.
 *
 * Dropping the fourth status colour was measured too: with "serious" in the set
 * the worst normal-vision pair was dE 13.6, below the 15 floor, so two statuses
 * were hard to separate even with full colour vision. Without it the worst pair
 * is 27.6.
 *
 * Status hues are the reserved set and are deliberately NOT themed with the
 * rest of the dashboard, so a status can never be mistaken for a series colour.
 * Text keeps the ink tokens throughout; no label is ever painted in a mark's
 * colour.
 */

// Reserved status palette. Fixed; not drawn from the dashboard's theme tokens.
const INK = {
  taken:    '#0ca30c',
  missed:   '#d03b3b',
  awaiting: '#fab219',
};
// Not a status. A day nobody watched is unknown, not bad, and painting it with
// a status hue would assert something the system does not know.
const UNCOUNTED = '#f0efec';

const STATES = {
  taken:     { glyph: '✓', label: 'Taken',             fill: INK.taken,    ink: '#0a7a0a' },
  missed:    { glyph: '✗', label: 'Not taken',         fill: INK.missed,   ink: '#a82f2f' },
  awaiting:  { glyph: '?', label: 'Awaiting your answer', fill: INK.awaiting, ink: '#8a6008' },
  uncounted: { glyph: '–', label: 'Not watched',       fill: UNCOUNTED,    ink: 'var(--text-secondary)' },
  none:      { glyph: '',  label: 'Nothing scheduled', fill: 'transparent', ink: 'var(--text-muted)' },
};

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

/** One day's doses reduce to the state that most needs a person's attention. */
function reduceDay(logs) {
  if (!logs || logs.length === 0) return { state: 'none', counts: {} };
  const counts = logs.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});
  if (counts.missed) return { state: 'missed', counts };
  if (counts.needs_verification) return { state: 'awaiting', counts };
  if (counts.taken) return { state: 'taken', counts };
  // skipped and camera_off both sit outside the adherence sum. They are kept
  // apart in the tooltip and the table, because "chose not to" and "nobody was
  // looking" are different facts even where the arithmetic treats them alike.
  if (counts.skipped || counts.camera_off) return { state: 'uncounted', counts };
  return { state: 'none', counts };
}

function describe(counts) {
  const order = ['taken', 'missed', 'needs_verification', 'skipped', 'camera_off', 'snoozed', 'scheduled'];
  const names = {
    taken: 'taken', missed: 'not taken', needs_verification: 'awaiting confirmation',
    skipped: 'skipped', camera_off: 'camera was off', snoozed: 'snoozed', scheduled: 'still due',
  };
  return order.filter(k => counts[k]).map(k => `${counts[k]} ${names[k]}`).join(', ');
}

export default function AdherenceStrip({ logs = [], days = 30, name }) {
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState(null);

  const cells = useMemo(() => {
    const byDay = new Map();
    for (const l of logs) {
      const when = l.taken_at || l.scheduled_time || l.createdAt;
      if (!when) continue;
      const k = dayKey(when);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(l);
    }
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = dayKey(d);
      out.push({ key: k, date: d, ...reduceDay(byDay.get(k)) });
    }
    return out;
  }, [logs, days]);

  const tally = useMemo(() => {
    const t = { taken: 0, missed: 0, awaiting: 0, uncounted: 0 };
    cells.forEach(c => { if (t[c.state] !== undefined) t[c.state] += 1; });
    return t;
  }, [cells]);

  // The headline the backend itself computes: camera_off is not a failure, so
  // it is not in the denominator.
  const denom = tally.taken + tally.missed;
  const pct = denom ? Math.round((tally.taken / denom) * 100) : null;

  return (
    <div className="adh">
      <div className="adh-head">
        <div>
          <div className="adh-title">{name ? `${name} — last ${days} days` : `Last ${days} days`}</div>
          <div className="adh-sub">
            {pct === null
              ? 'No doses to measure yet'
              : <>
                  <strong className="adh-pct">{pct}%</strong> of {denom} watched {denom === 1 ? 'dose' : 'doses'} taken
                  {tally.uncounted > 0 && <> · {tally.uncounted} {tally.uncounted === 1 ? 'day' : 'days'} not watched</>}
                </>}
          </div>
        </div>
        <button className="adh-toggle" onClick={() => setAsTable(v => !v)}>
          {asTable ? 'Show strip' : 'Show table'}
        </button>
      </div>

      {!asTable && (
        <>
          <div className="adh-strip" role="img"
               aria-label={`Daily medication over ${days} days: ${tally.taken} taken, ${tally.missed} not taken, ${tally.awaiting} awaiting an answer, ${tally.uncounted} not watched.`}>
            {cells.map(c => {
              const s = STATES[c.state];
              return (
                <div key={c.key} className={`adh-cell adh-${c.state}`}
                     style={{ background: s.fill, color: s.ink }}
                     onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)}
                     onFocus={() => setHover(c)} onBlur={() => setHover(null)}
                     tabIndex={0}
                     aria-label={`${c.date.toLocaleDateString()}: ${s.label}`}>
                  <span aria-hidden="true">{s.glyph}</span>
                </div>
              );
            })}
          </div>

          <div className="adh-tip" aria-live="polite">
            {hover
              ? <><strong>{hover.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
                  {' — '}{STATES[hover.state].label}
                  {describe(hover.counts) && <> ({describe(hover.counts)})</>}</>
              : <span className="adh-hint">Hover or focus a day for detail</span>}
          </div>
        </>
      )}

      {asTable && (
        <table className="adh-table">
          <caption className="adh-hint">Every day of the last {days}, as text.</caption>
          <thead><tr><th scope="col">Day</th><th scope="col">Outcome</th><th scope="col">Doses</th></tr></thead>
          <tbody>
            {cells.filter(c => c.state !== 'none').reverse().map(c => (
              <tr key={c.key}>
                <td>{c.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                <td><span aria-hidden="true">{STATES[c.state].glyph}</span> {STATES[c.state].label}</td>
                <td>{describe(c.counts) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* A legend is always present. Identity is never colour alone: each entry
          shows the same mark the cell carries. */}
      <ul className="adh-legend">
        {['taken', 'missed', 'awaiting', 'uncounted'].map(k => (
          <li key={k}>
            <span className="adh-key" style={{ background: STATES[k].fill, color: STATES[k].ink }}
                  aria-hidden="true">{STATES[k].glyph}</span>
            {STATES[k].label}
          </li>
        ))}
      </ul>

      <style>{`
        .adh { background: var(--surface); border: 1px solid var(--border-light);
               border-radius: var(--radius-lg); padding: 18px 20px; }
        .adh-head { display: flex; justify-content: space-between; align-items: flex-start;
                    gap: 16px; margin-bottom: 14px; }
        .adh-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
        .adh-sub { font-size: 13px; color: var(--text-secondary); margin-top: 3px; }
        .adh-pct { color: var(--text-primary); font-size: 15px; }
        .adh-toggle { font-size: 12px; padding: 5px 11px; border: 1px solid var(--border);
                      background: var(--surface); color: var(--text-secondary);
                      border-radius: var(--radius-full); cursor: pointer; white-space: nowrap; }
        .adh-toggle:hover { background: var(--surface-hover); color: var(--text-primary); }

        /* 2px gap so adjacent fills never touch; 4px rounding on the data mark. */
        .adh-strip { display: flex; flex-wrap: wrap; gap: 2px; }
        .adh-cell { width: 26px; height: 26px; border-radius: 4px;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 13px; font-weight: 700; line-height: 1; cursor: default; }
        .adh-cell:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .adh-none { border: 1px dashed var(--border); }
        .adh-uncounted { border: 1px solid var(--border); }

        .adh-tip { margin-top: 10px; min-height: 20px; font-size: 13px; color: var(--text-secondary); }
        .adh-hint { color: var(--text-muted); }

        .adh-legend { list-style: none; display: flex; flex-wrap: wrap; gap: 14px;
                      margin: 14px 0 0; padding: 0; font-size: 12px; color: var(--text-secondary); }
        .adh-legend li { display: flex; align-items: center; gap: 6px; }
        .adh-key { width: 18px; height: 18px; border-radius: 4px; display: inline-flex;
                   align-items: center; justify-content: center; font-size: 11px;
                   font-weight: 700; border: 1px solid var(--border-light); }

        .adh-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
        .adh-table th, .adh-table td { text-align: left; padding: 7px 10px;
                                       border-bottom: 1px solid var(--border-light);
                                       color: var(--text-secondary); }
        .adh-table th { color: var(--text-primary); font-weight: 600; }

        @media (max-width: 640px) { .adh-cell { width: 22px; height: 22px; font-size: 11px; } }
      `}</style>
    </div>
  );
}
