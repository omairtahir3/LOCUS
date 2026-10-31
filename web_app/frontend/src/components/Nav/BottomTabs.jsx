import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { MoreHorizontal, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useFacesWaiting } from '../../hooks/useFacesWaiting';
import { itemsFor, EXTRA_DESTINATIONS } from './navItems';

/**
 * Under 900px the dock becomes a bottom bar.
 *
 * Bottom, not top: on a phone held one-handed the top of the screen is the
 * hardest place to reach, and this audience includes people with limited
 * dexterity. Four destinations plus More, because five 44px targets is what
 * fits at 390px without shrinking any of them below the touch minimum.
 *
 * Which four is decided in navItems.js by `primary`, so the dock and this bar
 * can never disagree about what matters.
 */
export default function BottomTabs() {
  const { user } = useAuth();
  const [sheet, setSheet] = useState(false);
  const faces = useFacesWaiting();

  const items = itemsFor(user);
  const primary = items.filter(i => i.primary).slice(0, 4);
  const rest = [...items.filter(i => !i.primary), ...EXTRA_DESTINATIONS];

  useEffect(() => {
    if (!sheet) return;
    const esc = e => { if (e.key === 'Escape') setSheet(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [sheet]);

  return (
    <>
      <nav className="tabbar" aria-label="Main">
        {primary.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink key={to} to={to} end={!!end}
                   className={({ isActive }) => isActive ? 'is-active' : ''}>
            <span className="tabbar-glyph">
              <Icon size={20} aria-hidden="true" />
              {badge === 'faces' && faces > 0 && (
                <span className="dock-badge" aria-hidden="true">{faces}</span>
              )}
            </span>
            <span>{label}</span>
          </NavLink>
        ))}

        <button
          className={sheet ? 'is-active' : ''}
          onClick={() => setSheet(v => !v)}
          aria-expanded={sheet}
          aria-label={sheet
            ? 'Close more destinations'
            : `More destinations${faces > 0 ? `, ${faces} face${faces === 1 ? '' : 's'} waiting to be named` : ''}`}
        >
          <span className="tabbar-glyph">
            {sheet ? <X size={20} aria-hidden="true" /> : <MoreHorizontal size={20} aria-hidden="true" />}
            {!sheet && faces > 0 && <span className="dock-badge" aria-hidden="true">{faces}</span>}
          </span>
          <span>More</span>
        </button>
      </nav>

      {sheet && (
        <>
          <div className="sheet-scrim" onMouseDown={() => setSheet(false)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="More destinations">
            <ul>
              {rest.map(({ to, label, icon: Icon, hint }) => (
                <li key={to}>
                  <Link to={to} onClick={() => setSheet(false)}>
                    {Icon && <Icon size={18} aria-hidden="true" />}
                    <span className="sheet-text">
                      <span className="sheet-label">{label}</span>
                      {hint && <span className="sheet-hint">{hint}</span>}
                    </span>
                    {to === '/keyframes' && faces > 0 && (
                      <span className="dock-badge is-inline" aria-hidden="true">{faces}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
