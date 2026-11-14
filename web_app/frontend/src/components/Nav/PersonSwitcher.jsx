import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSelectedUser } from '../../context/SelectedUserContext';
import { caregiverAPI } from '../../services/api';

/**
 * Which family member every page is about.
 *
 * Replaces the bare <select> labelled "Viewing:" that each page rendered for
 * itself, so the answer to "whose day am I looking at?" lived in a different
 * place on every screen -- and on the pages that never rendered it, nowhere.
 * It is now beside the mark, in one place, on every screen.
 *
 * The selection logic is untouched: useSelectedUser's selectUser() still
 * writes localStorage and re-scopes the pages that read selectedUser. This is
 * a different control over the same state.
 *
 * THE STATUS DOT IS NOT DECORATION, AND IT IS NOT INVENTED
 *
 * GET /caregiver/users returns name, email and phone only -- no status -- so
 * the dot comes from each person's summary, where `pending_alerts` is a real
 * count the backend already computes. Two states only:
 *
 *   attention   pending_alerts > 0
 *   calm        pending_alerts === 0
 *   unknown     the request failed or has not returned -- drawn hollow
 *
 * Deliberately NOT derived from today_adherence: that field is labelled today
 * and carries period '7_days', so a dot built on it would quietly assert a
 * week's figure as a day's. The dot never stands alone; the popover writes the
 * count in words.
 */
export default function PersonSwitcher() {
  const { selectedUser, monitoringUsers, selectUser } = useSelectedUser() || {};
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState({});      // id -> pending_alerts | undefined
  const box = useRef(null);

  // Same fan-out the Family page already does, so no new endpoint and no new
  // shape. One pass when the list arrives; the popover is not a live monitor.
  useEffect(() => {
    if (!monitoringUsers?.length) return;
    let alive = true;
    Promise.all(monitoringUsers.map(u =>
      caregiverAPI.getUserSummary(u._id)
        .then(r => [u._id, r.data?.pending_alerts ?? 0])
        .catch(() => [u._id, undefined])
    )).then(pairs => { if (alive) setAlerts(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [monitoringUsers]);

  useEffect(() => {
    if (!open) return;
    const away = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!monitoringUsers || monitoringUsers.length === 0) return null;

  const dotState = (id) => {
    const n = alerts[id];
    if (n === undefined) return 'unknown';
    return n > 0 ? 'attention' : 'calm';
  };

  const dotWords = (id) => {
    const n = alerts[id];
    if (n === undefined) return 'status unknown';
    return n > 0 ? `${n} alert${n === 1 ? '' : 's'} waiting` : 'nothing waiting';
  };

  const initial = (selectedUser?.name || '?').charAt(0).toUpperCase();

  return (
    <div className="dock-pop-wrap" ref={box}>
      <button
        className="person-chip"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={`Viewing ${selectedUser?.name || 'nobody'}, ${dotWords(selectedUser?._id)}. Change person.`}
      >
        <span className="person-chip-avatar" aria-hidden="true">{initial}</span>
        <span className="person-chip-name">{selectedUser?.name || 'Select'}</span>
        <span className={`status-dot is-${dotState(selectedUser?._id)}`} aria-hidden="true" />
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="dock-pop" role="dialog" aria-label="Choose a family member">
          <div className="dock-pop-head"><span>Viewing</span></div>
          <ul className="person-list">
            {monitoringUsers.map(u => (
              <li key={u._id}>
                <button
                  className={u._id === selectedUser?._id ? 'is-selected' : ''}
                  onClick={() => { selectUser(u._id); setOpen(false); }}
                  aria-current={u._id === selectedUser?._id}
                >
                  <span className="person-chip-avatar" aria-hidden="true">
                    {(u.name || '?').charAt(0).toUpperCase()}
                  </span>
                  <span className="person-list-text">
                    <span className="person-list-name">{u.name}</span>
                    <span className="person-list-status">{dotWords(u._id)}</span>
                  </span>
                  <span className={`status-dot is-${dotState(u._id)}`} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
