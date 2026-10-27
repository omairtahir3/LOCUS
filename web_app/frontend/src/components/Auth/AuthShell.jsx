import { Link } from 'react-router-dom';
import Background from '../Landing/Background';
import './Auth.css';

// Shared frame for the sign-in, sign-up and reset pages: the landing page's
// background and logo, and one frosted card. Presentation only; each page
// keeps its own state, handlers and copy.
export default function AuthShell({ children, wide = false }) {
  return (
    <div className="auth">
      <Background />
      <header className="auth-top">
        <Link to="/" className="auth-logo"><img src="/logo.png" alt="LOCUS home" /></Link>
      </header>
      <main className={`auth-card ${wide ? 'auth-card--wide' : ''}`}>{children}</main>
    </div>
  );
}
