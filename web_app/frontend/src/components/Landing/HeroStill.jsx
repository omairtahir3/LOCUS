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

// The camera drawn flat, front view: the loading placeholder (no cards) and
// the fallback when WebGL is unavailable (with the cards laid out below).
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
        </defs>
        <ellipse cx="150" cy="238" rx="110" ry="8" fill="#2B2219" opacity="0.12" />
        <rect x="128" y="196" width="13" height="34" rx="4" fill="#18181B" />
        <rect x="159" y="196" width="13" height="34" rx="4" fill="#18181B" />
        <rect x="190" y="18" width="40" height="8" rx="4" fill="#26262B" />
        <rect x="30" y="24" width="240" height="172" rx="30" fill="#18181B" />
        <rect x="50" y="44" width="100" height="100" rx="20" fill="#0E0E10" />
        <circle cx="100" cy="94" r="39" fill="#1E1E22" />
        <circle cx="100" cy="94" r="31" fill="url(#still-glass)" />
        <circle cx="100" cy="94" r="17" fill="none" stroke="#4A4A55" strokeWidth="2" />
        <circle cx="100" cy="94" r="8" fill="#030305" />
        <ellipse cx="90" cy="82" rx="8" ry="5" fill="#FFFFFF" opacity="0.25" />
        <rect x="168" y="55" width="70" height="70" rx="4" fill="#0A0C10" stroke="#2A2D33" />
        <text x="203" y="162" textAnchor="middle" fontSize="15" fontWeight="700" fill="#9C968F"
          fontFamily="'Bricolage Grotesque', system-ui, sans-serif">LOCUS</text>
        <circle cx="246" cy="42" r="3" fill="#E9A23B" />
      </svg>
      {cards.length > 0 && (
        <div className="hero-still-cards">
          {cards.map(c => <HeroCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}
