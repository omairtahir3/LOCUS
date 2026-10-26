import { Fragment, useEffect, useRef, useState } from 'react';

// Splits a heading into words for the masked, staggered reveal. The text
// stays one real heading: words are inline spans, readable and selectable.
export function Words({ children }) {
  // The space sits between the inline-block words, where it cannot collapse.
  return String(children).split(' ').map((w, i) => (
    <Fragment key={i}>{i > 0 && ' '}<span className="w"><span style={{ '--i': i }}>{w}</span></span></Fragment>
  ));
}

const motionOk = () =>
  typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Page-wide scroll and pointer effects, plus the progress line and section
// dots it renders. Everything here is progressive: without JS, or with
// reduced motion, content is simply visible.
//  - reveals: [data-reveal] blocks get .in once when they enter (headings
//    animate word by word, body fades up); never re-triggered;
//  - [data-count]: real numbers count up once;
//  - .spot: a soft spotlight follows the cursor, with a slight lift;
//  - .lp-btn: a small magnetic pull on fine pointers;
//  - [data-loop]: CSS loops (marquee, CTA shapes) pause while off-screen.
// ponytail: IntersectionObserver and pointer events, no animation library.
export default function LandingEffects({ root, sections }) {
  const bar = useRef(null);
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ok = motionOk();
    el.classList.toggle('motion-ok', ok);
    const cleanups = [];

    // Progress line.
    let raf = 0;
    const paint = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.current?.style.setProperty('transform', `scaleX(${max > 0 ? window.scrollY / max : 0})`);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    paint();
    cleanups.push(() => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    });

    // Reveals and count-ups, once each.
    const once = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      const n = Number(e.target.dataset.count);
      if (n && ok) {
        const t0 = performance.now();
        const step = t => {
          const k = Math.min(1, (t - t0) / 1200);
          e.target.textContent = String(Math.round(n * (1 - (1 - k) ** 3)));
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      once.unobserve(e.target);
    }), { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
    el.querySelectorAll('[data-reveal], [data-count]').forEach(n => {
      if (ok && n.dataset.count) n.textContent = '0';
      once.observe(n);
    });
    cleanups.push(() => once.disconnect());

    // Loops pause off-screen.
    const loops = new IntersectionObserver(entries => entries.forEach(e =>
      e.target.classList.toggle('is-off', !e.isIntersecting)));
    el.querySelectorAll('[data-loop]').forEach(n => loops.observe(n));
    cleanups.push(() => loops.disconnect());

    // Section dots follow the section in the middle of the viewport.
    const dots = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) setActive(e.target.id);
    }), { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(s => { const n = document.getElementById(s.id); if (n) dots.observe(n); });
    cleanups.push(() => dots.disconnect());

    // Cursor spotlight on cards, magnetic buttons: fine pointers only.
    if (ok && window.matchMedia('(pointer: fine)').matches) {
      const move = e => {
        const spot = e.target.closest?.('.spot');
        if (spot) {
          const r = spot.getBoundingClientRect();
          spot.style.setProperty('--mx', `${e.clientX - r.left}px`);
          spot.style.setProperty('--my', `${e.clientY - r.top}px`);
        }
        const btn = e.target.closest?.('.lp-btn');
        if (btn) {
          const r = btn.getBoundingClientRect();
          const dx = (e.clientX - (r.left + r.width / 2)) * 0.18;
          const dy = (e.clientY - (r.top + r.height / 2)) * 0.3;
          btn.style.transform = `translate(${Math.max(-6, Math.min(6, dx))}px, ${Math.max(-4, Math.min(4, dy))}px)`;
        }
      };
      const out = e => {
        const btn = e.target.closest?.('.lp-btn');
        if (btn && !btn.contains(e.relatedTarget)) btn.style.transform = '';
      };
      el.addEventListener('pointermove', move, { passive: true });
      el.addEventListener('pointerout', out);
      cleanups.push(() => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerout', out);
      });
    }

    return () => cleanups.forEach(f => f());
  }, [root, sections]);

  return (
    <>
      <div className="lp-progress" aria-hidden="true"><span ref={bar} /></div>
      <nav className="lp-dots" aria-label="Sections">
        {sections.map(s => (
          <a key={s.id} href={`#${s.id}`} aria-label={s.label}
            aria-current={active === s.id ? 'true' : undefined}>
            <span className="lp-dots-label">{s.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
