/**
 * Adherence, or null when it was never measurable.
 *
 * GET /caregiver/users/:id/summary computes
 *
 *     adherence_percentage: totalValid > 0 ? taken / totalValid * 100 : 0
 *     totalValid = taken + missed
 *
 * with the comment "No resolved doses = 0%". So a person with nothing to
 * measure is reported as nought per cent adherent, and the screens printed
 * that verbatim -- a wearer who had not been prescribed anything, or whose
 * camera had not yet watched a dose, read as totally non-compliant.
 *
 * The field cannot be fixed here (no backend changes), but the condition
 * behind it is recoverable: taken and missed are both in the payload, so
 * `taken + missed === 0` is exactly the branch that produced the zero.
 *
 * Returns a rounded number, or null meaning "nothing to measure". Callers
 * render null as an em dash with a sentence, never as a figure.
 */
export function adherencePct(todayAdherence) {
  if (!todayAdherence) return null;
  const resolved = (todayAdherence.taken || 0) + (todayAdherence.missed || 0);
  if (resolved === 0) return null;
  const pct = todayAdherence.adherence_percentage;
  return typeof pct === 'number' ? Math.round(pct) : null;
}

/** The one spelling of "we cannot tell", so every card says it the same way. */
export const NO_DATA = '—';          // em dash
export const NO_DATA_LABEL = 'Not enough data yet';
