/**
 * One name per dose status, in sentence case.
 *
 * Four screens each built this label inline as
 * `(status || '').toUpperCase().replace('_', ' ')`, which produced NEEDS
 * VERIFICATION and CAMERA OFF -- the last all-caps text in the app, and the
 * only place a reader was shouted at. It also meant the word for a status
 * differed by screen: one of them special-cased 'CAMERA OFF' and the others
 * printed 'CAMERA OFF' only because the underscore replacement happened to
 * catch it.
 *
 * `tone` names what the status MEANS, not a colour, so the stylesheet decides
 * how to draw it and the two cannot drift:
 *
 *   taken     it happened
 *   missed    it did not happen
 *   wait      somebody has to answer something
 *   unknown   nobody was watching; outside the adherence sum either way
 *   due       still ahead
 */
export const DOSE_LOOK = {
  taken:              { label: 'Taken',            tone: 'taken' },
  missed:             { label: 'Not taken',        tone: 'missed' },
  snoozed:            { label: 'Snoozed',          tone: 'wait' },
  needs_verification: { label: 'Needs confirming', tone: 'wait' },
  camera_off:         { label: 'Camera was off',   tone: 'unknown' },
  skipped:            { label: 'Skipped',          tone: 'unknown' },
  scheduled:          { label: 'Scheduled',        tone: 'due' },
  pending:            { label: 'Scheduled',        tone: 'due' },
};

export const doseLook = (status) => DOSE_LOOK[status] || DOSE_LOOK.scheduled;
export const doseLabel = (status) => doseLook(status).label;
