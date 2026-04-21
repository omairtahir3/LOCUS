import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const { register, loading, error, setError } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ok = await register(name, email, password, role);
    if (ok) {
      if (role === 'caregiver') {
        navigate('/');
      } else {
        navigate('/my-dashboard');
      }
    }
  };

  return (
    <div className="auth-layout">
      <div className="auth-card">
        <img src="/logo.png" alt="LOCUS" className="auth-logo" />
        <h1 className="auth-title">Create Account</h1>
        <p className="auth-subtitle">Register for LOCUS</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Full Name</label>
            <input
              type="text"
              className="form-input"
              placeholder="Jane Smith"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(null); }}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Email Address</label>
            <input
              type="email"
              className="form-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-input"
              placeholder="Min. 6 characters"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              required
              minLength={6}
            />
          </div>
          <div className="form-group">
            <label className="form-label">I am a...</label>
            <div style={{
              display: 'flex', gap: 8, marginTop: 4,
            }}>
              {[
                { value: 'user', label: 'Normal User', desc: 'Track my own medications' },
                { value: 'caregiver', label: 'Caregiver', desc: 'Monitor family members' },
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRole(opt.value)}
                  style={{
                    flex: 1,
                    padding: '14px 16px',
                    borderRadius: 'var(--radius-md)',
                    border: `2px solid ${role === opt.value ? 'var(--primary)' : 'var(--border)'}`,
                    background: role === opt.value ? 'var(--primary-light)' : 'var(--surface)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{
                    fontWeight: 600, fontSize: '0.9rem',
                    color: role === opt.value ? 'var(--primary-dark)' : 'var(--text-primary)',
                  }}>
                    {opt.label}
                  </div>
                  <div style={{
                    fontSize: '0.75rem', marginTop: 2,
                    color: role === opt.value ? 'var(--primary)' : 'var(--text-muted)',
                  }}>
                    {opt.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
