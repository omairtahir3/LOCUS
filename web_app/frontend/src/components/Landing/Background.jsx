import { useEffect, useRef } from 'react';
import './Background.css';

// The page's background system, all from tokens (Background.css):
//  - fixed layers here: teal "aurora" blobs that drift and parallax against
//    scroll at different speeds, a faint dot grid masked to the centre, and
//    film grain;
//  - section tones (.tone-plain / .tone-tint) with soft wave tops and a
//    vertical wash into teal, applied by class on each section;
//  - the hero spotlight (.bg-spotlight), which brightens as the door opens.
//
// ponytail: plain CSS gradients and one passive scroll listener, no canvas;
// the blobs are radial gradients rather than blurred elements, so nothing
// re-rasterises while scrolling. Reduced motion: no drift, no parallax.
const BLOBS = [
  { cls: 'bg-blob--a', speed: -0.05 },
  { cls: 'bg-blob--b', speed: -0.12 },
  { cls: 'bg-blob--c', speed: -0.08 },
  { cls: 'bg-blob--d', speed: -0.16 },
  { cls: 'bg-blob--warm', speed: -0.1 },
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
        <div key={b.cls} className={`bg-blob ${b.cls}`} style={{ '--speed': b.speed }}><i /></div>
      ))}
      <div className="bg-dots" />
      <div className="bg-grain" />
    </div>
  );
}
