import { CheckCircle2 } from 'lucide-react';

// One capability card. Plain DOM, both here and over the 3D scene, so the
// text stays crisp at any pixel ratio.
export function HeroCard({ card }) {
  const Icon = card.icon;
  return (
    <div className={`hcard hcard--${card.cap}`}>
      {card.evidence && (
        <div className="hcard-frame">
          <span className="hcard-hand" />
          <span className="hcard-pill" />
        </div>
      )}
      <div className="hcard-row">
        <span className="hcard-icon">{Icon ? <Icon size={18} strokeWidth={2.2} /> : card.initial}</span>
        <span className="hcard-text">
          <strong>{card.title}</strong>
          <span>{card.meta}</span>
        </span>
      </div>
      {card.evidence && (
        <span className="hcard-status"><CheckCircle2 size={14} /> Taken</span>
      )}
    </div>
  );
}

// The camera drawn flat, front view (screen left, lens right): the loading
// placeholder (no cards) and the fallback when WebGL is unavailable (with
// the cards laid out below).
export default function HeroStill({ cards = [] }) {
  return (
    <div className={`hero-still ${cards.length ? 'hero-still--cards' : ''}`}>
      <svg className="hero-still-cam" viewBox="0 0 300 250" role="presentation">
        <defs>
          <radialGradient id="still-glass" cx="0.4" cy="0.38">
            <stop offset="0" stopColor="#4B4F8C" />
            <stop offset="0.45" stopColor="#1B1D33" />
            <stop offset="1" stopColor="#06070D" />
          </radialGradient>
          <linearGradient id="still-screen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4A3426" />
            <stop offset="0.3" stopColor="#5E7A7E" />
            <stop offset="0.55" stopColor="#1E7FA0" />
            <stop offset="1" stopColor="#0A3E5E" />
          </linearGradient>
        </defs>
        <ellipse cx="150" cy="204" rx="118" ry="8" fill="#2B2219" opacity="0.12" />
        <rect x="80" y="18" width="40" height="8" rx="4" fill="#26262B" />
        <rect x="30" y="24" width="240" height="172" rx="30" fill="#101012" />
        {/* front screen, left; LED above; wordmark low on the glass */}
        <rect x="46" y="42" width="104" height="136" rx="10" fill="#0A0C10" stroke="#2A2D33" />
        <rect x="54" y="60" width="88" height="84" rx="4" fill="url(#still-screen)" />
        <rect x="92" y="50" width="12" height="4" rx="2" fill="#E5332A" />
        <text x="98" y="164" textAnchor="middle" fontSize="14" fontWeight="700" fill="#D5DADF"
          fontFamily="'Bricolage Grotesque', system-ui, sans-serif">LOCUS</text>
        {/* lens housing, right, with the ribbed vent below */}
        <rect x="160" y="30" width="104" height="104" rx="22" fill="#0E0E10" stroke="#26262B" strokeWidth="2" />
        <rect x="170" y="40" width="84" height="84" rx="14" fill="#08080A" />
        <circle cx="212" cy="82" r="34" fill="#1E1E22" />
        <circle cx="212" cy="82" r="27" fill="url(#still-glass)" />
        <circle cx="212" cy="82" r="14" fill="none" stroke="#4A4A55" strokeWidth="2" />
        <circle cx="212" cy="82" r="6" fill="#030305" />
        <ellipse cx="203" cy="72" rx="7" ry="4" fill="#FFFFFF" opacity="0.25" />
        <rect x="166" y="140" width="92" height="44" rx="6" fill="#141417" />
        {[176, 189, 202, 215, 228, 241].map(x => <rect key={x} x={x} y="146" width="5" height="32" rx="2" fill="#0A0A0C" />)}
      </svg>
      {cards.length > 0 && (
        <div className="hero-still-cards">
          {cards.map(c => <HeroCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}
