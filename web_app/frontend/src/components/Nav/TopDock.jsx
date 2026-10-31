import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '../../context/AuthContext';
import { useFacesWaiting } from '../../hooks/useFacesWaiting';
import { itemsFor, isCaregiver } from './navItems';
import PersonSwitcher from './PersonSwitcher';
import ProfileMenu from './ProfileMenu';
import CommandPalette from './CommandPalette';
import AlertsBell from './AlertsBell';

/**
 * The floating dock that replaced the left sidebar.
 *
 * WHY THE SIDEBAR WENT
 *
 * It spent 260px of every screen -- a quarter of a 1024px tablet -- on a list
 * of eight words that do not change, and it organised them under "Main" and
 * "Monitoring", headings that describe the system's internals rather than
 * anything the reader wants. The content column paid for it on every page.
 *
 * THE ACTIVE INDICATOR
 *
 * One element with a layoutId, so framer-motion slides the same box between
 * items instead of cross-fading two. Under prefers-reduced-motion the layout
 * animation is switched off at the source rather than left to the global CSS
 * override -- a transform animation suppressed by CSS still recalculates, and
 * motion's own flag skips the work.
 *
 * ON SCROLL
 *
 * It shrinks and gains contrast; it never hides. A navigation that disappears
 * makes a reader hunt for it, and this audience should never have to.
 */
export default function TopDock() {
  const { user } = useAuth();
  const [shrunk, setShrunk] = useState(false);
  const reduce = useReducedMotion();
  const faces = useFacesWaiting();

  const items = itemsFor(user);
  const home = isCaregiver(user) ? '/dashboard' : '/my-dashboard';

  useEffect(() => {
    const onScroll = () => setShrunk(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`dock-bar${shrunk ? ' is-shrunk' : ''}`}>
      <div className="dock-left">
        <Link to={home} className="dock-mark" aria-label="LOCUS home">
          <img src="/logo.png" alt="LOCUS" />
        </Link>
        {isCaregiver(user) && <PersonSwitcher />}
      </div>

      <nav className="dock" aria-label="Main">
        <ul>
          {items.map(({ to, label, icon: Icon, end, badge }) => (
            <li key={to}>
              <NavLink to={to} end={!!end} className={({ isActive }) => isActive ? 'is-active' : ''}>
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        className="dock-indicator"
                        layoutId="dock-indicator"
                        aria-hidden="true"
                        transition={reduce
                          ? { duration: 0 }
                          : { type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
                    <Icon size={17} aria-hidden="true" />
                    <span className="dock-label">{label}</span>
                    {/* Keyframe Audit is not a dock item any more -- it sits
                        under People as "Review faces" -- so the badge is how
                        anyone learns a face is waiting. The count is announced
                        rather than left to a coloured dot. */}
                    {badge === 'faces' && faces > 0 && (
                      <>
                        <span className="dock-badge" aria-hidden="true">{faces}</span>
                        <span className="sr-only">
                          , {faces} face{faces === 1 ? '' : 's'} waiting to be named
                        </span>
                      </>
                    )}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="dock-right">
        <CommandPalette />
        <AlertsBell />
        <ProfileMenu />
      </div>
    </header>
  );
}
