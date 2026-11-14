import { useCallback, useEffect, useState } from 'react';
import { Check, AlertTriangle, Info, X } from 'lucide-react';
import { ToastContext } from './toastContext';

/**
 * Transient confirmations, without a dependency.
 *
 * ponytail: react-hot-toast and sonner both do this well, and neither is worth
 * 12 kB here. What this interface needs is four statuses, an auto-dismiss and a
 * close button, which is the file below. No promise chaining, no custom render
 * props, no positioning API -- one position, because a toast that can appear in
 * six places teaches the reader to look in six places.
 *
 * WHY A TOAST AND NOT AN ALERT ROW
 *
 * A toast is for something the person just did: the dose was marked taken, the
 * settings saved. It must never be the only place a fact appears, because it
 * leaves on a timer and this audience includes people who read slowly. Anything
 * that has to persist belongs on the page or in Notifications, and anything
 * urgent belongs in the notification path, which has retry and escalation
 * behind it. Nothing in here replaces either.
 *
 * ACCESSIBILITY
 *
 * The viewport is one live region, not a region per toast, so a screen reader
 * announces arrivals in order instead of interrupting itself. Errors are
 * assertive -- they interrupt, which is the point; everything else is polite.
 * Status is carried by an icon and the word, never by colour alone.
 */

const STATUS = {
  success: { icon: Check,          role: 'status' },
  error:   { icon: AlertTriangle,  role: 'alert'  },
  warning: { icon: AlertTriangle,  role: 'status' },
  info:    { icon: Info,           role: 'status' },
};

const DISMISS_MS = 5000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback(id => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  // `status` second rather than in an options object: every call site in this
  // app passes at most a status, and `toast('Saved', 'success')` reads.
  const toast = useCallback((message, status = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, message, status: STATUS[status] ? status : 'info' }]);
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map(t => <Toast key={t.id} {...t} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ id, message, status, onDismiss }) {
  const { icon: Icon, role } = STATUS[status];

  // The timer is per toast rather than one sweep over the list, so a toast
  // that arrives late still gets its full reading time.
  useEffect(() => {
    const t = setTimeout(() => onDismiss(id), DISMISS_MS);
    return () => clearTimeout(t);
  }, [id, onDismiss]);

  return (
    <div className={`toast toast-${status}`} role={role}>
      <Icon size={16} className="toast-icon" aria-hidden="true" />
      <p className="toast-message">{message}</p>
      <button className="toast-close" onClick={() => onDismiss(id)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
