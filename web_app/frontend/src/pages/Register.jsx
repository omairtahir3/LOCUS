import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { User, Mail, Lock, UserCheck, Heart, ArrowRight, AlertCircle } from 'lucide-react';
import { GoogleLogin } from '@react-oauth/google';
import AuthShell from '../components/Auth/AuthShell';
import { GoogleRoleDialog } from './Login';

// Google's button takes a fixed pixel width; keep it inside the card on phones.
const googleWidth = () => Math.min(350, window.innerWidth - 80);

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('caregiver');
  const { register, googleLogin, loading, error, setError } = useAuth();
  const navigate = useNavigate();

  const [googleRoleModal, setGoogleRoleModal] = useState({ show: false, token: null, name: '', picture: '', selectedRole: 'caregiver' });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ok = await register(name, email, password, role);
    if (ok) {
      if (role === 'caregiver') {
        navigate('/dashboard');
      } else {
        navigate('/my-dashboard');
      }
    }
  };

  return (
    <AuthShell wide>
      <h1 className="auth-title">Join LOCUS</h1>
      <p className="auth-subtitle">Start monitoring with intelligence and compassion.</p>

      {error && <div className="auth-alert auth-alert--error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}

      <form onSubmit={handleSubmit}>
        <div className="auth-field">
          <label className="auth-label" htmlFor="reg-name">Full Name</label>
          <div className="auth-input-wrap">
            <User className="auth-input-icon" size={20} aria-hidden="true" />
            <input
              id="reg-name"
              type="text"
              autoComplete="name"
              className="auth-input"
              placeholder="Enter your name"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              required
            />
          </div>
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor="reg-email">Email Address</label>
          <div className="auth-input-wrap">
            <Mail className="auth-input-icon" size={20} aria-hidden="true" />
            <input
              id="reg-email"
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
          <label className="auth-label" htmlFor="reg-password">Password</label>
          <div className="auth-input-wrap">
            <Lock className="auth-input-icon" size={20} aria-hidden="true" />
            <input
              id="reg-password"
              type="password"
              autoComplete="new-password"
              className="auth-input"
              placeholder="Create a strong password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              required
              minLength={6}
            />
          </div>
        </div>

        <div className="auth-field">
          <span className="auth-label" id="reg-role-label">I want to</span>
          <div className="auth-roles" role="group" aria-labelledby="reg-role-label" style={{ marginBottom: 6 }}>
            <button
              type="button"
              aria-pressed={role === 'caregiver'}
              className={`auth-role ${role === 'caregiver' ? 'is-active' : ''}`}
              onClick={() => setRole('caregiver')}
            >
              <UserCheck size={20} aria-hidden="true" />
              <h4>Be a Caregiver</h4>
              <p>Monitor family and handle alerts.</p>
            </button>
            <button
              type="button"
              aria-pressed={role === 'user'}
              className={`auth-role ${role === 'user' ? 'is-active' : ''}`}
              onClick={() => setRole('user')}
            >
              <Heart size={20} aria-hidden="true" />
              <h4>Track Myself</h4>
              <p>Manage my own meds and health.</p>
            </button>
          </div>
        </div>

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading ? 'Creating Account...' : 'Create Account'}
          {!loading && <ArrowRight size={18} />}
        </button>
      </form>

      <div className="auth-divider">or sign up with</div>

      <div className="auth-google">
        <GoogleLogin
          onSuccess={async (credentialResponse) => {
            const res = await googleLogin(credentialResponse.credential, role, false);
            if (res && res.requiresRole) {
              setGoogleRoleModal({ show: true, token: res.token, name: res.name, picture: res.picture, selectedRole: role });
              return;
            }
            if (res === true) {
              const savedUser = JSON.parse(localStorage.getItem('locus_user') || '{}');
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
        Already have an account? <Link to="/login">Sign in</Link>
      </p>

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
