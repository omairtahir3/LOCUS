/**
 * Waiting is not the same as nothing, and until now the interface said it was:
 * every page rendered `<div className="empty-state"><p>Loading...</p></div>`,
 * so a slow request and an empty cupboard were the same picture. A caregiver
 * who cannot tell them apart does not know whether to wait or to act.
 *
 * Bars rather than a spinner. A spinner says only "something is happening";
 * bars in the shape of the content say "this is where the rows will be", and
 * they do not rotate, which matters under prefers-reduced-motion -- the global
 * rule there kills the shimmer and leaves calm grey placeholders rather than a
 * spinner frozen mid-turn.
 *
 * `label` is read by screen readers via the live region; the bars are hidden
 * from them, because a list of empty boxes is not information.
 */
export default function Loading({ rows = 3, label = 'Loading' }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="loading-bars" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="loading-bar" />
        ))}
      </div>
    </div>
  );
}
