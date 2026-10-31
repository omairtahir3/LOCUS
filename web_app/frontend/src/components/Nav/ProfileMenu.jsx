import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { isCaregiver } from './navItems';

/**
 * The account, and the two things anyone does with it.
 *
 * Settings moved here from the navigation. It is not a destination in the
 * product -- nobody opens LOCUS to visit Settings -- and a dock is for the
 * places people actually go. Keeping it in the dock also cost a slot the
 * caregiver's seven destinations needed.
 */
export default function ProfileMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef(null);

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

  const picture = user?.picture || user?.profile_picture;
  const initial = (user?.name || 'U').charAt(0).toUpperCase();

  return (
    <div className="dock-pop-wrap" ref={box}>
      <button
        className="dock-icon-btn profile-btn"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-label={`Account: ${user?.name || 'signed in'}`}
      >
        {picture ? (
          <img
            src={picture}
            alt=""
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
            onError={e => { e.target.style.display = 'none'; }}
          />
        ) : (
          <span className="profile-initial" aria-hidden="true">{initial}</span>
        )}
      </button>

      {open && (
        <div className="dock-pop dock-pop-right" role="dialog" aria-label="Account">
          <div className="profile-id">
            <span className="profile-name">{user?.name || 'Signed in'}</span>
            <span className="profile-email">{user?.email || ''}</span>
            <span className="profile-role">{isCaregiver(user) ? 'Caregiver' : 'Wearer'}</span>
          </div>

          <Link to="/settings" className="dock-pop-action" onClick={() => setOpen(false)}>
            <Settings size={16} aria-hidden="true" />
            Settings
          </Link>

          <button className="dock-pop-action is-danger" onClick={logout}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
