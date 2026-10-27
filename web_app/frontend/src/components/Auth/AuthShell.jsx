import { Link } from 'react-router-dom';
import Background from '../Landing/Background';
import './Auth.css';

// Shared frame for the sign-in, sign-up and reset pages: the landing page's
// background with tiles on both sides, and one card with the logo at its top. Presentation only; each page
// keeps its own state, handlers and copy.
export default function AuthShell({ children, wide = false }) {
  return (
    <div className="auth">
      <Background variant="auth" />
      <main className={`auth-card ${wide ? 'auth-card--wide' : ''}`}>
        <Link to="/" className="auth-logo"><img src="/logo.png" alt="LOCUS home" /></Link>
        {children}
      </main>
    </div>
  );
}
