import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, CheckCircle, Eye, Bell, MapPin, Brain,
  Shield, Smartphone, Heart, User, Users, Target, Zap,
  Activity, Clock, ChevronDown
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './Landing.css';

/* ───── Floating shapes behind hero ───── */
const FloatingShapes = () => (
  <div className="floating-shapes" aria-hidden="true">
    <div className="shape shape-1"><Heart size={32} /></div>
    <div className="shape shape-2"><Shield size={28} /></div>
    <div className="shape shape-3"><Activity size={26} /></div>
    <div className="shape shape-4"><Eye size={30} /></div>
    <div className="shape shape-5"><Bell size={24} /></div>
    <div className="shape shape-6" />
    <div className="shape shape-7" />
    <div className="shape shape-8" />
  </div>
);

const Landing = () => {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  /* auto-redirect */
  useEffect(() => {
    if (token && user)
      navigate(user.role === 'caregiver' || user.role === 'admin'
        ? '/dashboard' : '/my-dashboard');
  }, [token, user, navigate]);

  /* scroll aware nav */
  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 60);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  /* reveal on scroll */
  useEffect(() => {
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => e.isIntersecting && e.target.classList.add('vis')),
      { threshold: 0.15 }
    );
    document.querySelectorAll('.anim').forEach(el => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  /* ───── data ───── */
  const userCards = [
    {
      id: 'elderly', icon: <User size={32} />, accent: '#0D9488',
      title: 'Elderly Care',
      desc: 'Simplified medication reminders, automatic verification, and one-tap SOS — designed for ease and dignity.',
      perks: ['Voice reminders', 'Fall detection', 'One-tap SOS']
    },
    {
      id: 'caregiver', icon: <Users size={32} />, accent: '#6366F1',
      title: 'Professional Caregiver',
      desc: 'A comprehensive dashboard for real-time patient monitoring, behavioral alerts, and schedule management.',
      perks: ['AI vision dashboard', 'Behavioral alerts', 'Multi-patient view']
    },
    {
      id: 'self', icon: <Target size={32} />, accent: '#F59E0B',
      title: 'Track Yourself',
      desc: 'Take charge of your own health. Automate supplement tracking and build lasting daily habits.',
      perks: ['Habit tracking', 'Personal insights', 'Sync across devices']
    }
  ];

  const capabilities = [
    { icon: <Eye />, t: 'AI Vision', d: 'YOLOv8 + MediaPipe detects medication intake automatically.', c: '#0D9488' },
    { icon: <Bell />, t: 'Smart Alerts', d: 'Only critical events reach you — zero notification fatigue.', c: '#6366F1' },
    { icon: <MapPin />, t: 'Geofencing', d: 'Safe-zone boundaries with instant wandering alerts.', c: '#F59E0B' },
    { icon: <Brain />, t: 'Behavioral AI', d: 'Detects unusual inactivity, routine shifts, and fall risk.', c: '#EC4899' },
    { icon: <Smartphone />, t: 'Cross-Platform', d: 'Mobile and web apps with role-adaptive interfaces.', c: '#0D9488' },
    { icon: <Shield />, t: 'Privacy-First', d: 'End-to-end encrypted, clinical-grade security.', c: '#6366F1' }
  ];

  return (
    <div className="lp">
      {/* ════════ NAV ════════ */}
      <nav className={`topnav ${scrolled ? 'topnav--solid' : ''}`}>
        <div className="topnav-inner">
          <img src="/logo.png" alt="LOCUS" className="topnav-logo" />
          <div className="topnav-actions">
            <a href="#who" className="topnav-link">Functionalties</a>
            <a href="#cap" className="topnav-link">Capabilities</a>
            <button className="btn-outline-s" onClick={() => navigate('/login')}>Sign In</button>
            <button className="btn-solid-s" onClick={() => navigate('/register')}>Get Started</button>
          </div>
        </div>
      </nav>

      {/* ════════ HERO ════════ */}
      <header className="hero">
        <FloatingShapes />
        <div className="hero-center anim">
          <span className="hero-chip"><Zap size={14} /> AI-Powered Health Monitoring</span>
          <h1>Your Health,<br />Your <em>Way.</em></h1>
          <p className="hero-sub">
            Whether you're caring for a loved one, managing patients, or tracking your own wellness
            — LOCUS adapts to you.
          </p>
          <div className="hero-ctas">
            <button className="btn-solid" onClick={() => navigate('/register')}>
              Create Free Account <ArrowRight size={18} />
            </button>
            <button className="btn-outline" onClick={() => navigate('/login')}>
              Sign In
            </button>
          </div>
        </div>
        <a href="#who" className="scroll-hint anim">
          <ChevronDown size={20} />
          <span>Explore</span>
        </a>
      </header>

      {/* ════════ WHO IT'S FOR ════════ */}
      <section className="who-section" id="who">
        <div className="section-label anim">
          <span className="label-chip">Made For Everyone</span>
          <h2>Three users. <em>One platform.</em></h2>
          <p>We built dedicated experiences for the three most important roles in the care ecosystem.</p>
        </div>
        <div className="user-cards">
          {userCards.map((c, i) => (
            <article key={c.id} className="ucard anim" style={{ '--i': i, '--ac': c.accent }}>
              <div className="ucard-icon">{c.icon}</div>
              <h3>{c.title}</h3>
              <p>{c.desc}</p>
              <ul className="ucard-perks">
                {c.perks.map((p, j) => <li key={j}><CheckCircle size={16} /> {p}</li>)}
              </ul>
              <button className="ucard-btn" onClick={() => navigate('/register')}>
                Get Started <ArrowRight size={16} />
              </button>
            </article>
          ))}
        </div>
      </section>

      {/* ════════ CAPABILITIES ════════ */}
      <section className="cap-section" id="cap">
        <div className="section-label anim">
          <span className="label-chip">Core Technology</span>
          <h2>Intelligent by <em>design.</em></h2>
        </div>
        <div className="cap-grid">
          {capabilities.map((c, i) => (
            <div key={i} className="cap-card anim" style={{ '--i': i, '--ac': c.c }}>
              <div className="cap-icon">{c.icon}</div>
              <h4>{c.t}</h4>
              <p>{c.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ════════ HOW ════════ */}
      <section className="how-section">
        <div className="section-label anim">
          <span className="label-chip">How It Works</span>
          <h2>Up and running in <em>minutes.</em></h2>
        </div>
        <div className="steps-row">
          {[
            { n: '01', t: 'Create your account', d: 'Pick your role — elderly, caregiver, or self-tracker.' },
            { n: '02', t: 'Set up your circle', d: 'Invite family members or connect patients securely.' },
            { n: '03', t: 'Let AI take over', d: 'Our vision pipeline monitors automatically. You get alerts only when it matters.' }
          ].map((s, i) => (
            <div key={i} className="step-card anim" style={{ '--i': i }}>
              <span className="step-num">{s.n}</span>
              <h4>{s.t}</h4>
              <p>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ════════ CTA ════════ */}
      <section className="bottom-cta anim">
        <div className="cta-box">
          <h2>Ready to get started?</h2>
          <p>Pick your path and experience intelligent health monitoring today.</p>
          <div className="cta-btns">
            <button className="btn-solid btn-lg" onClick={() => navigate('/register')}>
              Create Account <ArrowRight size={18} />
            </button>
            <button className="btn-outline btn-lg" onClick={() => navigate('/login')}>
              Sign In
            </button>
          </div>
        </div>
      </section>

      {/* ════════ FOOTER ════════ */}
      <footer className="site-footer">
        <img src="/logo.png" alt="LOCUS" height="28" />
        <div className="footer-links">
          <a href="#who">Functionalities</a>
          <a href="#cap">Capabilities</a>
          <a href="#">Privacy</a>
          <a href="#">Contact</a>
        </div>
        <p>© 2026 LOCUS. All rights reserved.</p>
      </footer>
    </div>
  );
};

export default Landing;
