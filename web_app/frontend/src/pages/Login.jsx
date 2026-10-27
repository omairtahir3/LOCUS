import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, ArrowRight, LogIn, X, CheckCircle, Users, Activity, AlertCircle } from 'lucide-react';
import { authAPI } from '../services/api';
import { GoogleLogin } from '@react-oauth/google';
import AuthShell from '../components/Auth/AuthShell';

// Google's button takes a fixed pixel width; keep it inside the card on phones.
const googleWidth = () => Math.min(350, window.innerWidth - 80);

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, googleLogin, loading, error, setError } = useAuth();
  const navigate = useNavigate();

  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMsg, setForgotMsg] = useState(null);
  const [forgotErr, setForgotErr] = useState(null);

  const [googleRoleModal, setGoogleRoleModal] = useState({ show: false, token: null, name: '', picture: '', selectedRole: 'caregiver' });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ok = await login(email, password);
    if (ok) {
      const savedUser = JSON.parse(localStorage.getItem('locus_user') || '{}');
      if (savedUser?.role === 'elderly') {
        localStorage.removeItem('locus_token');
        localStorage.removeItem('locus_user');
        setError('Elderly users must use the LOCUS mobile app. Web dashboard access is restricted.');
        return;
      }
      const role = savedUser?.role;
      if (role === 'caregiver' || role === 'admin') {
        navigate('/dashboard');
      } else {
        navigate('/my-dashboard');
      }
    }
  };

  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setForgotLoading(true);
    setForgotMsg(null);
    setForgotErr(null);
    try {
      const res = await authAPI.forgotPassword(forgotEmail);
      setForgotMsg(res.data.message || 'Reset link sent! Please check your email inbox.');
    } catch (err) {
      setForgotErr(err.response?.data?.error || 'Failed to send reset link.');
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="auth-title">Welcome Back</h1>
      <p className="auth-subtitle">Sign in to continue your care journey.</p>

      {error && <div className="auth-alert auth-alert--error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}

      <form onSubmit={handleSubmit}>
        <div className="auth-field">
          <label className="auth-label" htmlFor="login-email">Email Address</label>
          <div className="auth-input-wrap">
            <Mail className="auth-input-icon" size={20} aria-hidden="true" />
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              className="auth-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              required
            />
          </div>
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor="login-password">Password</label>
          <div className="auth-input-wrap">
            <Lock className="auth-input-icon" size={20} aria-hidden="true" />
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              className="auth-input"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              required
            />
          </div>
          <div className="auth-forgot">
            <button type="button" className="auth-link-btn"
              onClick={() => { setShowForgot(true); setForgotEmail(email); setForgotMsg(null); setForgotErr(null); }}>
              Forgot Password?
            </button>
          </div>
        </div>

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign In'}
          {!loading && <LogIn size={18} />}
        </button>
      </form>

      <div className="auth-divider">or continue with</div>

      <div className="auth-google">
        <GoogleLogin
          onSuccess={async (credentialResponse) => {
            const res = await googleLogin(credentialResponse.credential, 'caregiver', false);
            if (res && res.requiresRole) {
              setGoogleRoleModal({ show: true, token: res.token, name: res.name, picture: res.picture, selectedRole: 'caregiver' });
              return;
            }
            if (res === true) {
              const savedUser = JSON.parse(localStorage.getItem('locus_user') || '{}');
              if (savedUser?.role === 'elderly') {
                localStorage.removeItem('locus_token');
                localStorage.removeItem('locus_user');
                setError('Elderly users must use the LOCUS mobile app. Web dashboard access is restricted.');
                return;
              }
              if (savedUser?.role === 'caregiver' || savedUser?.role === 'admin') {
                navigate('/dashboard');
              } else {
                navigate('/my-dashboard');
              }
            }
          }}
          onError={() => setError('Google Sign-In failed or was cancelled')}
          theme="outline"
          shape="pill"
          size="large"
          width={googleWidth()}
        />
      </div>

      <p className="auth-footer">
        Don't have an account? <Link to="/register">Create one</Link>
      </p>

      {showForgot && (
        <div className="forgot-modal-overlay" onClick={(e) => { if (e.target.className === 'forgot-modal-overlay') setShowForgot(false); }}>
          <div className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="forgot-title">
            <button type="button" className="auth-close" aria-label="Close" onClick={() => setShowForgot(false)}>
              <X size={20} />
            </button>
            <h3 id="forgot-title">Reset Password</h3>
            <p>Enter your account email address and we will send you a secure 15-minute reset link.</p>

            {forgotMsg && (
              <div className="auth-alert auth-alert--ok" role="status">
                <CheckCircle size={18} />
                <span>{forgotMsg}</span>
              </div>
            )}
            {forgotErr && (
              <div className="auth-alert auth-alert--error" role="alert"><AlertCircle size={18} /><span>{forgotErr}</span></div>
            )}

            <form onSubmit={handleForgotSubmit}>
              <div className="auth-field">
                <label className="auth-label" htmlFor="forgot-email">Email Address</label>
                <div className="auth-input-wrap">
                  <Mail className="auth-input-icon" size={20} aria-hidden="true" />
                  <input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    className="auth-input"
                    placeholder="you@example.com"
                    value={forgotEmail}
                    onChange={(e) => { setForgotEmail(e.target.value); setForgotErr(null); }}
                    required
                  />
                </div>
              </div>
              <button type="submit" className="auth-submit" disabled={forgotLoading}>
                {forgotLoading ? 'Sending Link...' : 'Send Reset Link'}
                {!forgotLoading && <ArrowRight size={18} />}
              </button>
            </form>
          </div>
        </div>
      )}

      {googleRoleModal.show && (
        <GoogleRoleDialog
          modal={googleRoleModal}
          setModal={setGoogleRoleModal}
          loading={loading}
          onConfirm={async () => {
            const ok = await googleLogin(googleRoleModal.token, googleRoleModal.selectedRole, true);
            if (ok === true) {
              const savedUser = JSON.parse(localStorage.getItem('locus_user') || '{}');
              if (savedUser?.role === 'caregiver' || savedUser?.role === 'admin') {
                navigate('/dashboard');
              } else {
                navigate('/my-dashboard');
              }
            }
          }}
        />
      )}
    </AuthShell>
  );
}

// The Google first-sign-in role choice, shared with Register. Same two
// options, same copy and the same confirm handler the page passes in.
export function GoogleRoleDialog({ modal, setModal, loading, onConfirm }) {
  const pick = role => setModal(prev => ({ ...prev, selectedRole: role }));
  return (
    <div className="auth-overlay">
      <div className="auth-dialog auth-center" role="dialog" aria-modal="true" aria-labelledby="google-role-title">
        {modal.picture && (
          <img
            src={modal.picture}
            alt=""
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
            className="auth-avatar"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        )}
        <h2 id="google-role-title">Welcome, {modal.name}!</h2>
        <p>To complete your Google registration, please select your role in LOCUS:</p>

        <div className="auth-roles auth-roles--stack" style={{ marginBottom: 24 }}>
          <button type="button" aria-pressed={modal.selectedRole === 'caregiver'}
            className={`auth-role ${modal.selectedRole === 'caregiver' ? 'is-active' : ''}`}
            onClick={() => pick('caregiver')}>
            <span className="auth-role-title"><Users size={18} /> Be a Caregiver</span>
            <span className="auth-role-text">Monitor family members and handle medication alerts.</span>
          </button>
          <button type="button" aria-pressed={modal.selectedRole === 'user'}
            className={`auth-role ${modal.selectedRole === 'user' ? 'is-active' : ''}`}
            onClick={() => pick('user')}>
            <span className="auth-role-title"><Activity size={18} /> Track Myself</span>
            <span className="auth-role-text">Manage my own health, prescriptions, and daily schedule.</span>
          </button>
        </div>

        <button type="button" className="auth-submit" disabled={!modal.selectedRole || loading} onClick={onConfirm}>
          {loading ? 'Creating Account...' : 'Confirm & Complete Registration'}
        </button>
      </div>
    </div>
  );
}
