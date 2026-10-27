import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, ArrowRight, CheckCircle, AlertCircle } from 'lucide-react';
import { authAPI } from '../services/api';
import AuthShell from '../components/Auth/AuthShell';

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
      <AuthShell>
        <div className="auth-center">
          <AlertCircle size={48} className="auth-status-icon" color="var(--lc-danger)" aria-hidden="true" />
          <h1 className="auth-title">Invalid Reset Link</h1>
          <p className="auth-subtitle">This password reset link is missing required parameters or is invalid.</p>
          <Link to="/login" className="auth-submit">Back to Sign In</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="auth-title">Create New Password</h1>
      <p className="auth-subtitle">Please choose a strong, secure new password for your LOCUS account.</p>

      {error && (
        <div className="auth-alert auth-alert--error" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {success ? (
        <div className="auth-success" role="status">
          <CheckCircle size={48} color="var(--lc-taken)" className="auth-status-icon" aria-hidden="true" />
          <h3>Password Reset Successful!</h3>
          <p>Redirecting you to sign in...</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="reset-new">New Password</label>
            <div className="auth-input-wrap">
              <Lock className="auth-input-icon" size={20} aria-hidden="true" />
              <input
                id="reset-new"
                type="password"
                autoComplete="new-password"
                className="auth-input"
                placeholder="At least 6 characters"
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(null); }}
                required
              />
            </div>
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="reset-confirm">Confirm New Password</label>
            <div className="auth-input-wrap">
              <Lock className="auth-input-icon" size={20} aria-hidden="true" />
              <input
                id="reset-confirm"
                type="password"
                autoComplete="new-password"
                className="auth-input"
                placeholder="Re-enter new password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
                required
              />
            </div>
          </div>

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Resetting Password...' : 'Reset Password'}
            {!loading && <ArrowRight size={18} />}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
