import { CheckCircle2 } from 'lucide-react';

// Viewfinder corners, drawn over every thumbnail.
const CORNERS = 'M4 12V4h8 M60 4h8v8 M68 48v8h-8 M12 56H4v-8';

// Small framed "evidence" pictures, one per card, as the camera might have
// captured them. The detection box uses the card's capability colour
// (currentColor). Illustrations, not photos; flat fills so five copies on
// the page share no element ids.
const SCENES = {
  dose: (
    <>
      <rect width="72" height="60" fill="#D9C8AF" />
      <path d="M22 60c0-14 6-24 16-26 8-1 14 4 16 10l4 16z" fill="#B98563" />
      <path d="M40 34c3-6 9-8 13-5" stroke="#9C6C4D" strokeWidth="3" fill="none" strokeLinecap="round" />
      <rect x="33" y="24" width="14" height="7" rx="3.5" fill="#FFF" />
      <rect x="40" y="24" width="7" height="7" rx="3.5" fill="#1E6B57" />
      <rect x="29" y="19" width="22" height="17" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </>
  ),
  face: (
    <>
      <rect width="72" height="60" fill="#CDD6DB" />
      <path d="M14 60c2-12 11-18 22-18s20 6 22 18z" fill="#7D93A8" />
      <circle cx="36" cy="27" r="11" fill="#C99B79" />
      <path d="M25 26c0-8 5-13 11-13s11 5 11 12c-3-4-7-6-11-6s-8 3-11 7z" fill="#4A3428" />
      <rect x="22" y="12" width="28" height="30" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </>
  ),
  keys: (
    <>
      <rect width="72" height="60" fill="#A97B50" />
      <rect width="72" height="18" fill="#E6DCCD" />
      <circle cx="30" cy="34" r="7" fill="none" stroke="#C3C7CD" strokeWidth="2.5" />
      <path d="M35 38l14 6M44 42l2-4M48 43.5l2-4" stroke="#DADDE1" strokeWidth="3" strokeLinecap="round" />
      <path d="M26 39l-8 9M20 46l3 2" stroke="#A4A9B0" strokeWidth="3" strokeLinecap="round" />
      <rect x="14" y="24" width="40" height="27" rx="3" fill="none" stroke="#FFF" strokeWidth="2" />
    </>
  ),
  talk: (
    <>
      <rect width="72" height="60" fill="#D9C8AF" />
      <path d="M2 60c1-9 7-14 15-14s14 5 15 14z" fill="#8C6F9C" />
      <circle cx="17" cy="36" r="8" fill="#C99B79" />
      <path d="M40 60c1-9 7-14 15-14s14 5 15 14z" fill="#6E8A7A" />
      <circle cx="55" cy="36" r="8" fill="#A8775A" />
      <rect x="25" y="10" width="22" height="13" rx="6.5" fill="#FFF" />
      <path d="M30 16.5h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M31 23l-3 4 7-4z" fill="#FFF" />
    </>
  ),
  home: (
    <>
      <rect width="72" height="60" fill="#DDE8DA" />
      <path d="M0 40h72M24 0v60M52 0l-10 60" stroke="#FFF" strokeWidth="4" />
      <circle cx="36" cy="30" r="17" fill="currentColor" opacity="0.14" />
      <path d="M36 14c-6 0-10 4-10 10 0 7 10 16 10 16s10-9 10-16c0-6-4-10-10-10z" fill="currentColor" />
      <path d="M31 25l5-4 5 4v5h-10z" fill="#FFF" />
    </>
  ),
};

function Thumb({ id }) {
  return (
    <svg className="hcard-thumb" viewBox="0 0 72 60" aria-hidden="true">
      {SCENES[id]}
      <path d={CORNERS} stroke="#FFF" strokeWidth="2" fill="none" opacity="0.9" />
    </svg>
  );
}

// One capability card: framed thumbnail on the left, text on the right. Plain
// DOM, both here and over the 3D scene, so the text stays crisp.
export function HeroCard({ card }) {
  return (
    <div className={`hcard hcard--${card.cap}`}>
      <Thumb id={card.id} />
      <span className="hcard-text">
        <strong>{card.title}</strong>
        <span>{card.meta}</span>
        {card.status && <em className="hcard-status"><CheckCircle2 size={13} /> {card.status}</em>}
      </span>
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
        <rect x="80" y="18" width="40" height="8" rx="4" fill="#111113" />
        <rect x="30" y="24" width="240" height="172" rx="30" fill="#0B0B0C" />
        {/* front screen, left; LED above; wordmark low on the glass */}
        <rect x="46" y="42" width="104" height="136" rx="10" fill="#050608" stroke="#1E2024" />
        <rect x="54" y="60" width="88" height="84" rx="4" fill="url(#still-screen)" />
        <rect x="92" y="50" width="12" height="4" rx="2" fill="#E5332A" />
        <text x="98" y="164" textAnchor="middle" fontSize="14" fontWeight="700" fill="#D5DADF"
          fontFamily="'Bricolage Grotesque', system-ui, sans-serif">LOCUS</text>
        {/* lens housing, right, with the ribbed vent below */}
        <rect x="160" y="30" width="104" height="104" rx="22" fill="#0B0B0C" stroke="#1E1E21" strokeWidth="2" />
        <rect x="170" y="40" width="84" height="84" rx="14" fill="#050506" />
        <circle cx="212" cy="82" r="34" fill="#151518" />
        <circle cx="212" cy="82" r="27" fill="url(#still-glass)" />
        <circle cx="212" cy="82" r="14" fill="none" stroke="#4A4A55" strokeWidth="2" />
        <circle cx="212" cy="82" r="6" fill="#030305" />
        <ellipse cx="203" cy="72" rx="7" ry="4" fill="#FFFFFF" opacity="0.25" />
        <rect x="166" y="140" width="92" height="44" rx="6" fill="#050506" />
        {[176, 189, 202, 215, 228, 241].map(x => <rect key={x} x={x} y="146" width="5" height="32" rx="2" fill="#1C1C1F" />)}
      </svg>
      {cards.length > 0 && (
        <div className="hero-still-cards">
          {cards.map(c => <HeroCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}
