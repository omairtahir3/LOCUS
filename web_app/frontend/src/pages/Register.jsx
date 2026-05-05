import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { User, Mail, Lock, UserCheck, Heart, ArrowRight } from 'lucide-react';

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('caregiver');
  const { register, loading, error, setError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');

      .reg-container {
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

      .reg-mesh {
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

      .reg-card {
        background: rgba(255, 255, 255, 0.8);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.5);
        border-radius: 32px;
        width: 100%;
        max-width: 500px;
        padding: 48px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.08);
        position: relative;
        z-index: 1;
      }

      .reg-logo {
        height: 32px;
        margin-bottom: 24px;
      }

      .reg-title {
        font-size: 2rem;
        font-weight: 800;
        color: #1E293B;
        margin-bottom: 8px;
        letter-spacing: -0.02em;
      }

      .reg-subtitle {
        color: #64748B;
        margin-bottom: 32px;
        font-size: 1rem;
      }

      .reg-form-group {
        margin-bottom: 20px;
        text-align: left;
      }

      .reg-label {
        display: block;
        font-size: 0.875rem;
        font-weight: 600;
        color: #475569;
        margin-bottom: 8px;
        padding-left: 4px;
      }

      .reg-input-wrapper {
        position: relative;
      }

      .reg-input-icon {
        position: absolute;
        left: 14px;
        top: 50%;
        transform: translateY(-50%);
        color: #94A3B8;
      }

      .reg-input {
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

      .reg-input:focus {
        outline: none;
        border-color: #0D9488;
        box-shadow: 0 0 0 4px rgba(13, 148, 136, 0.1);
      }

      .role-selector {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-bottom: 24px;
      }

      .role-btn {
        padding: 16px;
        border-radius: 18px;
        border: 2px solid #E2E8F0;
        background: white;
        cursor: pointer;
        transition: all 0.2s;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .role-btn.active {
        border-color: #0D9488;
        background: rgba(13, 148, 136, 0.03);
        box-shadow: 0 4px 12px rgba(13, 148, 136, 0.08);
      }

      .role-btn h4 {
        font-size: 0.95rem;
        font-weight: 700;
        color: #1E293B;
      }

      .role-btn.active h4 {
        color: #0D9488;
      }

      .role-btn p {
        font-size: 0.75rem;
        color: #64748B;
        line-height: 1.3;
      }

      .reg-submit-btn {
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
      }

      .reg-submit-btn:hover {
        background: #0F766E;
        transform: translateY(-2px);
        box-shadow: 0 20px 25px -5px rgba(13, 148, 136, 0.4);
      }

      .reg-submit-btn:disabled {
        opacity: 0.7;
        cursor: not-allowed;
        transform: none;
      }

      .reg-footer {
        margin-top: 24px;
        color: #64748B;
        font-size: 0.9rem;
      }

      .reg-footer a {
        color: #0D9488;
        font-weight: 700;
        text-decoration: none;
      }

      .reg-error {
        background: #FEF2F2;
        color: #991B1B;
        padding: 12px 16px;
        border-radius: 12px;
        font-size: 0.85rem;
        font-weight: 500;
        margin-bottom: 24px;
        border-left: 4px solid #EF4444;
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

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
    <div className="reg-container">
      <div className="reg-mesh"></div>
      
      <div className="reg-card">
        <Link to="/">
          <img src="/logo.png" alt="LOCUS" className="reg-logo" />
        </Link>
        
        <h1 className="reg-title">Join LOCUS</h1>
        <p className="reg-subtitle">Start monitoring with intelligence and compassion.</p>

        {error && <div className="reg-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="reg-form-group">
            <label className="reg-label">Full Name</label>
            <div className="reg-input-wrapper">
              <User className="reg-input-icon" size={18} />
              <input
                type="text"
                className="reg-input"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null); }}
                required
              />
            </div>
          </div>

          <div className="reg-form-group">
            <label className="reg-label">Email Address</label>
            <div className="reg-input-wrapper">
              <Mail className="reg-input-icon" size={18} />
              <input
                type="email"
                className="reg-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); }}
                required
              />
            </div>
          </div>

          <div className="reg-form-group">
            <label className="reg-label">Password</label>
            <div className="reg-input-wrapper">
              <Lock className="reg-input-icon" size={18} />
              <input
                type="password"
                className="reg-input"
                placeholder="Create a strong password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                required
                minLength={6}
              />
            </div>
          </div>

          <div className="reg-form-group">
            <label className="reg-label">I want to</label>
            <div className="role-selector">
              <button
                type="button"
                className={`role-btn ${role === 'caregiver' ? 'active' : ''}`}
                onClick={() => setRole('caregiver')}
              >
                <UserCheck size={20} style={{ marginBottom: 4 }} />
                <h4>Be a Caregiver</h4>
                <p>Monitor family and handle alerts.</p>
              </button>
              <button
                type="button"
                className={`role-btn ${role === 'user' ? 'active' : ''}`}
                onClick={() => setRole('user')}
              >
                <Heart size={20} style={{ marginBottom: 4 }} />
                <h4>Track Myself</h4>
                <p>Manage my own meds and health.</p>
              </button>
            </div>
          </div>

          <button type="submit" className="reg-submit-btn" disabled={loading}>
            {loading ? 'Creating Account...' : 'Create Account'}
            {!loading && <ArrowRight size={18} />}
          </button>
        </form>

        <p className="reg-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
