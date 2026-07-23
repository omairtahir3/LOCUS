import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, ArrowRight, CheckCircle, AlertCircle } from 'lucide-react';
import { authAPI } from '../services/api';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const id = searchParams.get('id');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');

      .reset-container {
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

      .reset-mesh {
        position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 0;
        background-image: 
          radial-gradient(at 0% 0%, rgba(13, 148, 136, 0.1) 0px, transparent 50%),
          radial-gradient(at 100% 100%, rgba(99, 102, 241, 0.1) 0px, transparent 50%);
        pointer-events: none;
      }

      .reset-card {
        background: rgba(255, 255, 255, 0.85);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.6);
        border-radius: 32px;
        width: 100%;
        max-width: 460px;
        padding: 48px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.08);
        position: relative;
        z-index: 1;
        text-align: center;
      }

      .reset-logo { height: 32px; margin-bottom: 24px; }
      .reset-title { font-size: 1.8rem; font-weight: 800; color: #1E293B; margin-bottom: 8px; letter-spacing: -0.02em; }
      .reset-subtitle { color: #64748B; margin-bottom: 32px; font-size: 0.95rem; line-height: 1.5; }
      .reset-form-group { margin-bottom: 20px; text-align: left; }
      .reset-label { display: block; font-size: 0.85rem; font-weight: 600; color: #334155; margin-bottom: 8px; }
      
      .reset-input-wrapper { position: relative; display: flex; align-items: center; }
      .reset-input-icon { position: absolute; left: 16px; color: #94A3B8; pointer-events: none; }
      .reset-input {
        width: 100%; padding: 14px 16px 14px 44px; background: white; border: 1px solid #E2E8F0;
        border-radius: 16px; font-size: 0.95rem; font-family: inherit; color: #1E293B; transition: all 0.2s;
        box-sizing: border-box;
      }
      .reset-input:focus { outline: none; border-color: #0D9488; box-shadow: 0 0 0 4px rgba(13, 148, 136, 0.1); }

      .reset-submit-btn {
        width: 100%; padding: 16px; background: linear-gradient(135deg, #0D9488 0%, #0F766E 100%);
        color: white; border: none; border-radius: 16px; font-size: 1rem; font-weight: 700; font-family: inherit;
        cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px;
        box-shadow: 0 10px 15px -3px rgba(13, 148, 136, 0.3); margin-top: 10px;
      }
      .reset-submit-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 15px 20px -3px rgba(13, 148, 136, 0.4); }
      .reset-submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }

      .reset-error {
        background: #FEF2F2; color: #991B1B; padding: 14px 16px; border-radius: 12px; font-size: 0.85rem;
        font-weight: 500; margin-bottom: 24px; border-left: 4px solid #EF4444; text-align: left; display: flex;
        align-items: center; gap: 8px;
      }
      .reset-success {
        background: #ecfdf5; color: #065f46; padding: 20px; border-radius: 16px; font-size: 0.95rem;
        font-weight: 500; margin-bottom: 24px; border: 1px solid #10b981; text-align: center;
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await authAPI.resetPassword({ id, token, newPassword });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  if (!token || !id) {
    return (
      <div className="reset-container">
        <div className="reset-mesh"></div>
        <div className="reset-card">
          <AlertCircle size={48} color="#EF4444" style={{ margin: '0 auto 16px auto' }} />
          <h1 className="reset-title">Invalid Reset Link</h1>
          <p className="reset-subtitle">This password reset link is missing required parameters or is invalid.</p>
          <Link to="/login" className="reset-submit-btn" style={{ textDecoration: 'none' }}>Back to Sign In</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="reset-container">
      <div className="reset-mesh"></div>
      
      <div className="reset-card">
        <Link to="/">
          <img src="/logo.png" alt="LOCUS" className="reset-logo" />
        </Link>
        
        <h1 className="reset-title">Create New Password</h1>
        <p className="reset-subtitle">Please choose a strong, secure new password for your LOCUS account.</p>

        {error && (
          <div className="reset-error">
            <AlertCircle size={18} color="#EF4444" />
            <span>{error}</span>
          </div>
        )}

        {success ? (
          <div className="reset-success">
            <CheckCircle size={48} color="#10b981" style={{ margin: '0 auto 12px auto', display: 'block' }} />
            <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem', color: '#065f46' }}>Password Reset Successful!</h3>
            <p style={{ margin: '0', color: '#047857', fontSize: '0.9rem' }}>Redirecting you to sign in...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="reset-form-group">
              <label className="reset-label">New Password</label>
              <div className="reset-input-wrapper">
                <Lock className="reset-input-icon" size={18} />
                <input
                  type="password"
                  className="reset-input"
                  placeholder="At least 6 characters"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setError(null); }}
                  required
                />
              </div>
            </div>

            <div className="reset-form-group">
              <label className="reset-label">Confirm New Password</label>
              <div className="reset-input-wrapper">
                <Lock className="reset-input-icon" size={18} />
                <input
                  type="password"
                  className="reset-input"
                  placeholder="Re-enter new password"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
                  required
                />
              </div>
            </div>

            <button type="submit" className="reset-submit-btn" disabled={loading}>
              {loading ? 'Resetting Password...' : 'Reset Password'}
              {!loading && <ArrowRight size={18} />}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
