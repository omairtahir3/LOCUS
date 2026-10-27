import { useEffect, useRef } from 'react';
import { Pill, ScanFace, KeyRound, MessageCircle, MapPin } from 'lucide-react';
import './Background.css';

// The page's background system, all from tokens (Background.css):
//  - fixed layers here: "aurora" colour fields (teal, mint, sky, peach) that
//    drift and parallax against scroll at different speeds, a faint dot grid
//    masked to the centre, and film grain;
//  - decorative elements: glossy orbs and frosted capability tiles on the
//    right, dashed rings and contour lines on the left, all parallaxed and
//    gently floating, and kept off the left text column;
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

// Decorative elements. Tiles and orbs stay on the right; the left side only
// gets low-contrast line work, so nothing busy sits under the text column.
const TILES = [
  { Icon: Pill, cap: 'dose', pos: { top: '24vh', right: '4vw' }, f: 0.0013, amp: 90 },
  { Icon: ScanFace, cap: 'face', pos: { top: '62vh', right: '10vw' }, f: 0.0009, amp: 140 },
  { Icon: KeyRound, cap: 'item', pos: { top: '12vh', right: '30vw' }, f: 0.0016, amp: 70 },
  { Icon: MessageCircle, cap: 'talk', pos: { top: '82vh', right: '30vw' }, f: 0.0011, amp: 110 },
  { Icon: MapPin, cap: 'place', pos: { top: '44vh', right: '6vw' }, f: 0.0007, amp: 160 },
];
const ORBS = [
  { cls: 'bg-orb--lg', f: 0.0006, amp: 200 },
  { cls: 'bg-orb--md', f: 0.0012, amp: 120 },
  { cls: 'bg-orb--sm', f: 0.0018, amp: 80 },
];
// Topographic-style contours: concentric, slightly irregular ellipses.
const CONTOURS = [0, 1, 2, 3, 4, 5, 6].map(i => ({
  rx: 270 - i * 36 + (i % 2) * 10,
  ry: 220 - i * 30 - (i % 3) * 6,
  rot: -18 + i * 7,
}));

const float = (f, amp) => ({ '--f': f, '--amp': `${amp}px` });

export default function Background() {
  const ref = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const tick = () => {
      raf = 0;
      ref.current?.style.setProperty('--sy', String(Math.round(window.scrollY)));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(tick); };
    window.addEventListener('scroll', onScroll, { passive: true });
    tick();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="bg" aria-hidden="true">
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
      {ORBS.map(o => (
        <div key={o.cls} className={`bg-float bg-orb ${o.cls}`} style={float(o.f, o.amp)}><i /></div>
      ))}
      {TILES.map((t, i) => {
        const { Icon } = t;
        return (
          <div key={t.cap} className={`bg-float bg-tile hcard--${t.cap}`}
            style={{ ...t.pos, ...float(t.f, t.amp), '--d': `${-i * 1.7}s` }}>
            <i><Icon size={26} strokeWidth={2} /></i>
          </div>
        );
      })}
      <div className="bg-dots" />
      <div className="bg-grain" />
    </div>
  );
}
