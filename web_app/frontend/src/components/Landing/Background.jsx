import { useEffect, useRef } from 'react';
import './Background.css';

// The page's background system, all from tokens (Background.css):
//  - fixed layers here: "aurora" colour fields (teal, mint, sky, peach) that
//    drift and parallax against scroll at different speeds, a faint dot grid
//    masked to the centre, and film grain;
//  - section tones (.tone-plain / .tone-tint) with soft wave tops and a
//    vertical wash into teal, applied by class on each section;
//  - the hero spotlight (.bg-spotlight), which brightens as the door opens.
//
// ponytail: plain CSS gradients and one passive scroll listener, no canvas;
// the blobs are radial gradients rather than blurred elements, so nothing
// re-rasterises while scrolling. Reduced motion: no drift, no parallax.

// Aurora colour fields, all inside the viewport so colour is present the whole
// way down the page. Parallax is an oscillation tied to scroll (CSS sin()),
// each field at its own speed (--f) and depth (--amp).
const BLOBS = [
  { cls: 'bg-blob--teal', f: 0.0011, amp: 140 },
  { cls: 'bg-blob--sky', f: 0.0007, amp: 180 },
  { cls: 'bg-blob--peach', f: 0.0014, amp: 110 },
  { cls: 'bg-blob--mint', f: 0.0009, amp: 160 },
  { cls: 'bg-blob--deep', f: 0.0005, amp: 220 },
];

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
        <div key={b.cls} className={`bg-blob ${b.cls}`} style={{ '--f': b.f, '--amp': `${b.amp}px` }}><i /></div>
      ))}
      <div className="bg-dots" />
      <div className="bg-grain" />
    </div>
  );
}
