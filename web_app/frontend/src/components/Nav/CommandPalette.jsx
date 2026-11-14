import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useSelectedUser } from '../../context/SelectedUserContext';
import { itemsFor, isCaregiver, EXTRA_DESTINATIONS } from './navItems';

/**
 * Ctrl/Cmd+K: go anywhere by typing.
 *
 * The dock carries seven destinations and the app has more routes than that.
 * Rather than grow the dock or bury things in a "More" menu on the desktop,
 * everything reachable is reachable here -- including Review faces, which is
 * no longer a dock item.
 *
 * For caregivers it also searches PEOPLE, because "open Margaret" is the
 * actual intent far more often than "open the family page and then find
 * Margaret". Selecting a person navigates to that person's detail route,
 * which already exists and keeps its own guard.
 *
 * ponytail: no cmdk, no fuzzy-search dependency. Substring matching over at
 * most a dozen labels and a handful of names does not need a library, and a
 * fuzzy matcher on this little data mostly produces surprising orderings.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { monitoringUsers } = useSelectedUser() || {};

  // Opening always starts from a clean query. Done here rather than in an
  // effect on `open`: an effect would fire a second render every time, and
  // this is a direct consequence of the action, not state to synchronise.
  const show = () => { setQ(''); setCursor(0); setOpen(true); };

  // Global shortcut, bound on window so it works wherever focus is.
  useEffect(() => {
    const onKey = e => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(prev => {
          if (!prev) { setQ(''); setCursor(0); }
          return !prev;
        });
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo(() => {
    const pages = [
      ...itemsFor(user).map(i => ({ to: i.to, label: i.label, icon: i.icon, group: 'Pages' })),
      ...EXTRA_DESTINATIONS.map(i => ({ ...i, group: 'Pages' })),
    ];
    const people = isCaregiver(user)
      ? (monitoringUsers || []).map(u => ({
          to: `/family/${u._id}`, label: u.name, hint: u.email, group: 'People',
        }))
      : [];
    const all = [...pages, ...people];
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 8);
    return all.filter(r =>
      r.label.toLowerCase().includes(needle) ||
      (r.hint || '').toLowerCase().includes(needle)
    ).slice(0, 8);
  }, [q, user, monitoringUsers]);

  const go = (r) => { if (r) { setOpen(false); navigate(r.to); } };

  const onKeyDown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); go(results[cursor]); }
  };

  return (
    <>
      <button
        className="dock-icon-btn"
        onClick={show}
        aria-label="Search pages and people. Shortcut: Control or Command K"
      >
        <Search size={18} aria-hidden="true" />
      </button>

      {open && (
        <div className="palette-scrim" onMouseDown={() => setOpen(false)}>
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="palette-field">
              <Search size={16} aria-hidden="true" />
              <input
                ref={input}
                autoFocus
                value={q}
                onChange={e => { setQ(e.target.value); setCursor(0); }}
                onKeyDown={onKeyDown}
                placeholder={isCaregiver(user) ? 'Go to a page or a person' : 'Go to a page'}
                aria-label="Search pages and people"
              />
              <kbd>esc</kbd>
            </div>

            {results.length === 0 ? (
              <p className="palette-empty">Nothing matches "{q}".</p>
            ) : (
              <ul className="palette-list" role="listbox" aria-label="Results">
                {results.map((r, i) => {
                  const Icon = r.icon;
                  return (
                    <li key={`${r.group}-${r.to}`}>
                      <button
                        className={i === cursor ? 'is-active' : ''}
                        role="option"
                        aria-selected={i === cursor}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => go(r)}
                      >
                        {Icon
                          ? <Icon size={16} aria-hidden="true" />
                          : <span className="palette-avatar" aria-hidden="true">
                              {r.label.charAt(0).toUpperCase()}
                            </span>}
                        <span className="palette-label">{r.label}</span>
                        {r.hint && <span className="palette-hint">{r.hint}</span>}
                        <span className="palette-group">{r.group}</span>
                        {i === cursor && <CornerDownLeft size={14} aria-hidden="true" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
