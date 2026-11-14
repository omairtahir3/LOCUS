import { useEffect, useRef } from 'react';
import { CheckCircle2, UserRound, Package, Home, MessageCircle, MapPin, Pill, ScanFace } from 'lucide-react';
import './Background.css';

// The page's background system, all from tokens (Background.css):
//  - fixed layers here: "aurora" colour fields (teal, mint, sky, peach) that
//    drift and parallax against scroll at different speeds, a faint dot grid
//    masked to the centre, and film grain;
//  - decorative elements: frosted capability tiles on the right, dashed rings
//    and contour lines on the left, all parallaxed and gently floating, and
//    kept off the left text column;
//  - HeroChips: small notification chips around the hero camera only (they
//    would sit behind text further down), fading as the real cards fly out;
//  - section tones (.tone-plain / .tone-tint) with soft wave tops and a
//    vertical wash into teal, applied by class on each section;
//  - the hero spotlight (.bg-spotlight), which brightens as the door opens.
//
// ponytail: plain CSS gradients and one passive scroll listener, no canvas;
// the blobs are radial gradients rather than blurred elements, so nothing
// re-rasterises while scrolling. Reduced motion: no drift, no parallax.

// Aurora colour fields, all inside the viewport so colour is present the whole
// way down the page. Parallax is an oscillation tied to scroll (CSS sin()),
// each element at its own speed (--f) and depth (--amp).
const BLOBS = [
  { cls: 'bg-blob--teal', f: 0.0011, amp: 140 },
  { cls: 'bg-blob--sky', f: 0.0007, amp: 180 },
  { cls: 'bg-blob--peach', f: 0.0014, amp: 110 },
  { cls: 'bg-blob--mint', f: 0.0009, amp: 160 },
  { cls: 'bg-blob--deep', f: 0.0005, amp: 220 },
];

// Hero chips: moments LOCUS really reports, like a live feed. Placed in % of
// the hero scene panel, two above the camera and two below it (the camera
// fills roughly 32-72% of the panel's height), never beside it.
const CHIPS = [
  { Icon: CheckCircle2, cap: 'dose', text: 'Dose taken', meta: '8:02', pos: { top: '11%', left: '4%' } },
  { Icon: UserRound, cap: 'face', text: 'Sara arrived', meta: '10:40', pos: { top: '20%', right: '1%' } },
  { Icon: Package, cap: 'item', text: 'Glasses: bedroom', meta: '12:15', pos: { top: '79%', right: '2%' } },
  { Icon: Home, cap: 'place', text: 'Back home', meta: '18:05', pos: { top: '89%', left: '8%' } },
];
// Frosted capability tiles. 'landing': right side only, so nothing busy sits
// under the text column, and hidden while the hero is on screen (the chips
// and camera own that space). 'auth': both sides of the centred card.
const TILES = {
  landing: [
    { Icon: Package, cap: 'item', pos: { top: '14vh', right: '28vw' }, f: 0.0016, amp: 70 },
    { Icon: MapPin, cap: 'place', pos: { top: '50vh', right: '8vw' }, f: 0.0007, amp: 160 },
    { Icon: MessageCircle, cap: 'talk', pos: { top: '64vh', right: '22vw' }, f: 0.0011, amp: 110 },
  ],
  auth: [
    { Icon: Pill, cap: 'dose', pos: { top: '20vh', left: '9vw' } },
    { Icon: ScanFace, cap: 'face', pos: { top: '54vh', left: '4vw' } },
    { Icon: Home, cap: 'place', pos: { top: '78vh', left: '15vw' } },
    { Icon: Package, cap: 'item', pos: { top: '16vh', right: '11vw' } },
    { Icon: MapPin, cap: 'place', pos: { top: '50vh', right: '5vw' } },
    { Icon: MessageCircle, cap: 'talk', pos: { top: '76vh', right: '16vw' } },
  ],
};
// Topographic-style contours: concentric, slightly irregular ellipses.
const CONTOURS = [0, 1, 2, 3, 4, 5, 6].map(i => ({
  rx: 270 - i * 36 + (i % 2) * 10,
  ry: 220 - i * 30 - (i % 3) * 6,
  rot: -18 + i * 7,
}));

const float = (f, amp) => ({ '--f': f, '--amp': `${amp}px` });

// Notification chips around the hero camera. Visible from the start of the
// hero until the cards begin (a .beat driven by the hero's --p).
export function HeroChips({ until }) {
  return (
    <div className="hero-chips beat" style={{ '--a': -1, '--b': until }} aria-hidden="true">
      {CHIPS.map((c, i) => {
        const { Icon } = c;
        return (
          <div key={c.text} className={`bg-chip hcard--${c.cap}`} style={{ ...c.pos, '--d': `${-i * 2.3}s` }}>
            <span>
              <b><Icon size={16} strokeWidth={2.4} /></b>
              {c.text}
              <small>{c.meta}</small>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function Background({ variant = 'landing', tilesAfter }) {
  const ref = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    // Looked up once: this ran querySelector on every scroll frame.
    const gate = tilesAfter ? document.querySelector(tilesAfter) : null;
    const tick = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      el.style.setProperty('--sy', String(Math.round(window.scrollY)));
      // The decorative loops run only while the first screen is in view; see
      // the data-drift rules in Background.css for why.
      el.dataset.drift = window.scrollY < window.innerHeight * 1.2 ? 'on' : 'off';
      // Tiles stay hidden until the element they wait for has mostly scrolled by.
      if (gate) {
        el.dataset.tiles =
          gate.getBoundingClientRect().bottom < window.innerHeight * 0.5 ? 'on' : 'off';
      }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(tick); };
    window.addEventListener('scroll', onScroll, { passive: true });
    tick();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [tilesAfter]);

  return (
    <div ref={ref} className="bg" data-tiles={tilesAfter ? 'off' : 'on'} data-drift="on"
      aria-hidden="true">
      {BLOBS.map(b => (
        <div key={b.cls} className={`bg-blob ${b.cls}`} style={float(b.f, b.amp)}><i /></div>
      ))}
      <svg className="bg-contours bg-float" viewBox="0 0 600 600" style={float(0.0005, 140)}>
        {CONTOURS.map((c, i) => (
          <ellipse key={i} cx="300" cy="300" rx={c.rx} ry={c.ry} transform={`rotate(${c.rot} 300 300)`} />
        ))}
      </svg>
      <div className="bg-float bg-ring bg-ring--a" style={float(0.0008, 120)}><i /></div>
      <div className="bg-float bg-ring bg-ring--b" style={float(0.0013, 80)}><i /></div>
      {TILES[variant].map((t, i) => {
        const { Icon } = t;
        return (
          <div key={i} className={`bg-float bg-tile hcard--${t.cap}`}
            style={{ ...t.pos, ...float(t.f ?? 0.0006 + i * 0.0002, t.amp ?? 40), '--d': `${-i * 1.7}s` }}>
            <i><Icon size={26} strokeWidth={2} /></i>
          </div>
        );
      })}
      <div className="bg-dots" />
      <div className="bg-grain" />
    </div>
  );
}
