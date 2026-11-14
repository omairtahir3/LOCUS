import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Siren } from 'lucide-react';
import { notificationAPI } from '../../services/api';
import { formatSmartDate } from '../../utils/dateUtils';

/**
 * Alerts, from anywhere in the app.
 *
 * Three states, and the difference between the second and third is the point:
 *
 *   quiet        a plain bell
 *   unread       a bell with a count
 *   emergency    a siren glyph, a red ring, and the word "Emergency"
 *
 * An SOS must not look like four unread reminders wearing the same red dot.
 * The glyph changes, not only the colour, so the distinction survives
 * greyscale and colour-blindness -- and the dropdown names it in words.
 *
 * `emergency` is read from the notification TYPE the backend already sends
 * ('emergency', set in socket.js), not inferred from wording.
 */
const POLL_MS = 60000;          // the Node notification cron's own interval
const EMERGENCY_TYPES = ['emergency', 'sos'];

export default function AlertsBell({ socket }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const box = useRef(null);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const res = await notificationAPI.getAll({ limit: 6 });
        if (!alive) return;
        setItems(res.data?.notifications || []);
        setUnread(res.data?.unread_count || 0);
      } catch { /* keep the last known state rather than claiming calm */ }
    };
    read();
    const t = setInterval(read, POLL_MS);
    // A resolved emergency must stop announcing itself at once rather than at
    // the end of a 60-second poll -- the caregiver has just pressed
    // "Acknowledge & Resolve" and is looking straight at the bell. The server
    // marks the notification read; this is what makes the siren go out now.
    const onResolved = () => read();
    socket?.on('sos_resolved', onResolved);
    // And the other direction: anything newly written for this person.
    //
    // Without it the bell was only ever as fresh as the 60-second poll, so a
    // caregiver who sent a message from the family page watched nothing
    // happen and reasonably concluded the send had failed. The server now
    // emits notification:new into the recipient's room as it stores the row.
    socket?.on('notification:new', onResolved);
    return () => {
      alive = false;
      clearInterval(t);
      socket?.off('sos_resolved', onResolved);
      socket?.off('notification:new', onResolved);
    };
  }, [socket]);

  // Close on outside click and on Escape: a popover that can only be closed by
  // hitting the same small button again is a trap on a touch screen.
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

  // is_read is the flag the rest of the app reads (Notifications.jsx uses it);
  // read_at exists alongside it but is the timestamp, not the test.
  const emergency = items.some(n => EMERGENCY_TYPES.includes(n.type) && !n.is_read);

  const label = emergency ? 'Alerts, emergency active'
    : unread ? `Alerts, ${unread} unread`
    : 'Alerts, none unread';

  return (
    <div className="dock-pop-wrap" ref={box}>
      <button
        className={`dock-icon-btn bell${emergency ? ' bell-emergency' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-label={label}
        aria-expanded={open}
      >
        {emergency ? <Siren size={18} aria-hidden="true" /> : <Bell size={18} aria-hidden="true" />}
        {!emergency && unread > 0 && (
          <span className="bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="dock-pop dock-pop-right" role="dialog" aria-label="Recent alerts">
          <div className="dock-pop-head">
            <span>{emergency ? 'Emergency' : 'Alerts'}</span>
            {unread > 0 && <span className="dock-pop-count">{unread} unread</span>}
          </div>

          {items.length === 0 ? (
            <p className="dock-pop-empty">Nothing waiting.</p>
          ) : (
            <ul className="dock-pop-list">
              {items.map(n => (
                <li key={n._id} className={EMERGENCY_TYPES.includes(n.type) ? 'is-emergency' : ''}>
                  <span className="dock-pop-title">{n.title}</span>
                  <span className="dock-pop-when">{formatSmartDate(n.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}

          <Link to="/notifications" className="dock-pop-all" onClick={() => setOpen(false)}>
            See all alerts
          </Link>
        </div>
      )}
    </div>
  );
}
