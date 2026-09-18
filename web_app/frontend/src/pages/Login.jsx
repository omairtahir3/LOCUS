import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, ArrowRight, LogIn, X, CheckCircle, Users, Activity } from 'lucide-react';
import { authAPI } from '../services/api';
import { GoogleLogin } from '@react-oauth/google';

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

  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');

      .login-container {
        min-height: 100vh;
        background-color: #F8FAFC;
        font-family: 'Outfit', sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
        position: relative;
        overflow: hidden;
      }

      .login-mesh {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 0;
        background-image: 
          radial-gradient(at 0% 0%, rgba(13, 148, 136, 0.1) 0px, transparent 50%),
          radial-gradient(at 100% 100%, rgba(99, 102, 241, 0.1) 0px, transparent 50%);
        pointer-events: none;
      }

      .login-card {
        background: rgba(255, 255, 255, 0.8);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.5);
        border-radius: 32px;
        width: 100%;
        max-width: 450px;
        padding: 48px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.08);
        position: relative;
        z-index: 1;
        text-align: center;
      }

      .login-logo {
        height: 32px;
        margin-bottom: 24px;
      }

      .login-title {
        font-size: 2rem;
        font-weight: 800;
        color: #1E293B;
        margin-bottom: 8px;
        letter-spacing: -0.02em;
      }

      .login-subtitle {
        color: #64748B;
        margin-bottom: 32px;
        font-size: 1rem;
      }

      .login-form-group {
        margin-bottom: 20px;
        text-align: left;
      }

      .login-label {
        display: block;
        font-size: 0.875rem;
        font-weight: 600;
        color: #475569;
        margin-bottom: 8px;
        padding-left: 4px;
      }

      .login-input-wrapper {
        position: relative;
      }

      .login-input-icon {
        position: absolute;
        left: 14px;
        top: 50%;
        transform: translateY(-50%);
        color: #94A3B8;
      }

      .login-input {
        width: 100%;
        padding: 12px 14px 12px 42px;
        background: white;
        border: 1px solid #E2E8F0;
        border-radius: 14px;
        font-size: 0.95rem;
        font-family: inherit;
        transition: all 0.2s;
        color: #1E293B;
      }

      .login-input:focus {
        outline: none;
        border-color: #0D9488;
        box-shadow: 0 0 0 4px rgba(13, 148, 136, 0.1);
      }

      .login-submit-btn {
        width: 100%;
        padding: 14px;
        background: #0D9488;
        color: white;
        border: none;
        border-radius: 14px;
        font-size: 1rem;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.3s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        box-shadow: 0 10px 15px -3px rgba(13, 148, 136, 0.3);
        margin-top: 10px;
      }

      .login-submit-btn:hover {
        background: #0F766E;
        transform: translateY(-2px);
        box-shadow: 0 20px 25px -5px rgba(13, 148, 136, 0.4);
      }

      .login-submit-btn:disabled {
        opacity: 0.7;
        cursor: not-allowed;
        transform: none;
      }

      .login-footer {
        margin-top: 24px;
        color: #64748B;
        font-size: 0.9rem;
      }

      .login-footer a {
        color: #0D9488;
        font-weight: 700;
        text-decoration: none;
      }

      .login-error {
        background: #FEF2F2;
        color: #991B1B;
        padding: 12px 16px;
        border-radius: 12px;
        font-size: 0.85rem;
        font-weight: 500;
        margin-bottom: 24px;
        border-left: 4px solid #EF4444;
        text-align: left;
      }

      .forgot-link {
        display: block;
        text-align: right;
        font-size: 0.85rem;
        color: #0D9488;
        font-weight: 600;
        text-decoration: none;
        margin-top: 6px;
        cursor: pointer;
      }
      .forgot-link:hover { text-decoration: underline; }

      .forgot-modal-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px;
      }
      .forgot-modal {
        background: white; border-radius: 24px; padding: 36px; max-width: 420px; width: 100%;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25); text-align: left; position: relative;
      }
      .forgot-modal h3 { font-size: 1.5rem; font-weight: 800; color: #1E293B; margin: 0 0 8px 0; }
      .forgot-modal p { font-size: 0.9rem; color: #64748B; margin: 0 0 24px 0; line-height: 1.5; }
      .forgot-close-btn {
        position: absolute; top: 20px; right: 20px; background: none; border: none;
        color: #94A3B8; cursor: pointer; padding: 4px; border-radius: 50%; display: flex;
      }
      .forgot-close-btn:hover { background: #F1F5F9; color: #475569; }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

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
    <div className="login-container">
      <div className="login-mesh"></div>
      
      <div className="login-card">
        <Link to="/">
          <img src="/logo.png" alt="LOCUS" className="login-logo" />
        </Link>
        
        <h1 className="login-title">Welcome Back</h1>
        <p className="login-subtitle">Sign in to continue your care journey.</p>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="login-form-group">
            <label className="login-label">Email Address</label>
            <div className="login-input-wrapper">
              <Mail className="login-input-icon" size={18} />
              <input
                type="email"
                className="login-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                required
              />
            </div>
          </div>

          <div className="login-form-group">
            <label className="login-label">Password</label>
            <div className="login-input-wrapper">
              <Lock className="login-input-icon" size={18} />
              <input
                type="password"
                className="login-input"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                required
              />
            </div>
            <a onClick={() => { setShowForgot(true); setForgotEmail(email); setForgotMsg(null); setForgotErr(null); }} className="forgot-link">
              Forgot Password?
            </a>
          </div>

          <button type="submit" className="login-submit-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
            {!loading && <LogIn size={18} />}
          </button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', margin: '24px 0 16px 0' }}>
          <div style={{ flex: 1, height: '1px', background: '#E2E8F0' }}></div>
          <span style={{ padding: '0 12px', color: '#94A3B8', fontSize: '0.85rem', fontWeight: '500' }}>or continue with</span>
          <div style={{ flex: 1, height: '1px', background: '#E2E8F0' }}></div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
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
            width="350"
          />
        </div>

        <p className="login-footer">
          Don't have an account? <Link to="/register">Create one</Link>
        </p>
      </div>

      {showForgot && (
        <div className="forgot-modal-overlay" onClick={(e) => { if (e.target.className === 'forgot-modal-overlay') setShowForgot(false); }}>
          <div className="forgot-modal">
            <button className="forgot-close-btn" onClick={() => setShowForgot(false)}>
              <X size={20} />
            </button>
            <h3>Reset Password</h3>
            <p>Enter your account email address and we will send you a secure 15-minute reset link.</p>

            {forgotMsg && (
              <div style={{ background: '#ecfdf5', color: '#065f46', padding: '12px 16px', borderRadius: '12px', fontSize: '0.85rem', fontWeight: '500', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '4px solid #10b981' }}>
                <CheckCircle size={18} color="#10b981" />
                <span>{forgotMsg}</span>
              </div>
            )}
            {forgotErr && (
              <div className="login-error" style={{ marginBottom: '20px' }}>{forgotErr}</div>
            )}

            <form onSubmit={handleForgotSubmit}>
              <div className="login-form-group">
                <label className="login-label">Email Address</label>
                <div className="login-input-wrapper">
                  <Mail className="login-input-icon" size={18} />
                  <input
                    type="email"
                    className="login-input"
                    placeholder="you@example.com"
                    value={forgotEmail}
                    onChange={(e) => { setForgotEmail(e.target.value); setForgotErr(null); }}
                    required
                  />
                </div>
              </div>
              <button type="submit" className="login-submit-btn" disabled={forgotLoading}>
                {forgotLoading ? 'Sending Link...' : 'Send Reset Link'}
                {!forgotLoading && <ArrowRight size={18} />}
              </button>
            </form>
          </div>
        </div>
      )}

      {googleRoleModal.show && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(15, 23, 42, 0.75)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '20px'
        }}>
          <div style={{
            background: '#ffffff', borderRadius: '24px', padding: '32px',
            width: '100%', maxWidth: '440px', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
            textAlign: 'center'
          }}>
            {googleRoleModal.picture && (
              <img 
                src={googleRoleModal.picture} 
                alt="" 
                referrerPolicy="no-referrer"
                crossOrigin="anonymous"
                style={{ width: '70px', height: '70px', borderRadius: '50%', margin: '0 auto 16px auto', border: '3px solid #3B82F6', objectFit: 'cover' }} 
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            )}
            <h2 style={{ fontSize: '1.5rem', fontWeight: '700', color: '#1E293B', marginBottom: '8px' }}>
              Welcome, {googleRoleModal.name}!
            </h2>
            <p style={{ color: '#64748B', fontSize: '0.95rem', marginBottom: '24px' }}>
              To complete your Google registration, please select your role in LOCUS:
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px', textAlign: 'left' }}>
              <button
                type="button"
                onClick={() => setGoogleRoleModal(prev => ({ ...prev, selectedRole: 'caregiver' }))}
                style={{
                  padding: '16px', borderRadius: '16px', border: `2px solid ${googleRoleModal.selectedRole === 'caregiver' ? '#3B82F6' : '#E2E8F0'}`,
                  background: googleRoleModal.selectedRole === 'caregiver' ? '#EFF6FF' : '#ffffff',
                  cursor: 'pointer', transition: 'all 0.2s'
                }}
              >
                <div style={{ fontWeight: '600', fontSize: '1.05rem', color: '#1E293B', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Users size={18} color="#3B82F6" /> Be a Caregiver
                </div>
                <div style={{ fontSize: '0.85rem', color: '#64748B' }}>Monitor family members and handle medication alerts.</div>
              </button>

              <button
                type="button"
                onClick={() => setGoogleRoleModal(prev => ({ ...prev, selectedRole: 'user' }))}
                style={{
                  padding: '16px', borderRadius: '16px', border: `2px solid ${googleRoleModal.selectedRole === 'user' ? '#3B82F6' : '#E2E8F0'}`,
                  background: googleRoleModal.selectedRole === 'user' ? '#EFF6FF' : '#ffffff',
                  cursor: 'pointer', transition: 'all 0.2s'
                }}
              >
                <div style={{ fontWeight: '600', fontSize: '1.05rem', color: '#1E293B', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Activity size={18} color="#EC4899" /> Track Myself
                </div>
                <div style={{ fontSize: '0.85rem', color: '#64748B' }}>Manage my own health, prescriptions, and daily schedule.</div>
              </button>
            </div>

            <button
              type="button"
              disabled={!googleRoleModal.selectedRole || loading}
              onClick={async () => {
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
              style={{
                width: '100%', padding: '14px', borderRadius: '14px',
                background: !googleRoleModal.selectedRole ? '#94A3B8' : '#3B82F6',
                color: '#ffffff', fontWeight: '600', fontSize: '1rem', border: 'none', cursor: !googleRoleModal.selectedRole ? 'not-allowed' : 'pointer',
                boxShadow: !googleRoleModal.selectedRole ? 'none' : '0 10px 15px -3px rgba(59, 130, 246, 0.3)'
              }}
            >
              {loading ? 'Creating Account...' : 'Confirm & Complete Registration'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
