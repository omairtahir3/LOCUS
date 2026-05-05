import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, ArrowRight, LogIn } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { login, loading, error, setError } = useAuth();
  const navigate = useNavigate();

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
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const ok = await login(email, password);
    if (ok) {
      const savedUser = JSON.parse(localStorage.getItem('locus_user') || '{}');
      const role = savedUser?.role;
      if (role === 'caregiver' || role === 'admin') {
        navigate('/dashboard');
      } else {
        navigate('/my-dashboard');
      }
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
          </div>

          <button type="submit" className="login-submit-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
            {!loading && <LogIn size={18} />}
          </button>
        </form>

        <p className="login-footer">
          Don't have an account? <Link to="/register">Create one</Link>
        </p>
      </div>
    </div>
  );
}
