import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Scroll choreography beyond the hero, for desktop with motion allowed only
// (the page loads this lazily; it shares gsap with the hero chunk). Without
// it, every section below is a plain, fully visible layout. Animates only
// transform and opacity. Returns a cleanup that undoes pins and styles.
export default function landingMotion(root) {
  const added = [];
  const flag = (el, cls) => { el.classList.add(cls); added.push([el, cls]); };

  const ctx = gsap.context(() => {
    // c) A day with LOCUS: pinned while the rail fills and the moments step.
    const day = root.querySelector('.day');
    if (day) {
      flag(day, 'day--pinned');
      const items = [...day.querySelectorAll('.day-list li')];
      const cards = [...day.querySelectorAll('.day-card')];
      const list = day.querySelector('.day-list');
      let last = -1;
      ScrollTrigger.create({
        trigger: day,
        start: 'top top',
        end: () => `+=${window.innerHeight * 2.6}`,
        pin: true,
        scrub: true,
        invalidateOnRefresh: true,
        onUpdate: self => {
          list.style.setProperty('--fill', self.progress.toFixed(3));
          const i = Math.min(items.length - 1, Math.floor(self.progress * items.length));
          if (i === last) return;
          last = i;
          items.forEach((n, k) => n.classList.toggle('is-active', k === i));
          cards.forEach((n, k) => {
            n.classList.toggle('is-active', k === i);
            n.classList.toggle('is-past', k < i);
          });
        },
      });
    }

    // d) Device mockups tilt and parallax against each other.
    const stage = root.querySelector('.devices-stage');
    if (stage) {
      gsap.timeline({ scrollTrigger: { trigger: stage, start: 'top bottom', end: 'bottom top', scrub: true } })
        .fromTo('.dev--laptop', { y: 90, rotateY: -20, rotateX: 10 }, { y: -50, rotateY: -6, rotateX: 3, ease: 'none' }, 0)
        .fromTo('.dev--phone', { y: 200, rotateY: 26, rotateX: 6 }, { y: -110, rotateY: 10, rotateX: 0, ease: 'none' }, 0);
    }

    // e) Capabilities: pinned while the track scrolls sideways; cards scale
    //    up as they reach the centre.
    const caps = root.querySelector('.caps');
    const track = caps?.querySelector('.caps-track');
    if (track) {
      flag(caps, 'caps--h');
      const cards = [...track.children];
      const span = () => Math.max(0, track.offsetWidth - document.documentElement.clientWidth);
      const scale = () => {
        const mid = window.innerWidth / 2;
        cards.forEach(c => {
          const r = c.getBoundingClientRect();
          const d = Math.min(1, Math.abs(r.left + r.width / 2 - mid) / window.innerWidth);
          c.style.setProperty('--s', (1 - d * 0.16).toFixed(3));
        });
      };
      gsap.to(track, {
        x: () => -span(),
        ease: 'none',
        scrollTrigger: {
          trigger: caps,
          start: 'top top',
          end: () => `+=${span()}`,
          pin: true,
          scrub: true,
          invalidateOnRefresh: true,
          onUpdate: scale,
          onRefresh: scale,
        },
      });
    }

    // g) The connection line draws itself through each section it crosses.
    root.querySelectorAll('.thread path').forEach(path => {
      gsap.fromTo(path, { strokeDashoffset: 1 }, {
        strokeDashoffset: 0,
        ease: 'none',
        scrollTrigger: { trigger: path.closest('section'), start: 'top 80%', end: 'bottom 50%', scrub: true },
      });
    });
  }, root);

  const refresh = () => ScrollTrigger.refresh();
  document.fonts?.ready.then(refresh);

  return () => {
    ctx.revert();
    added.forEach(([el, cls]) => el.classList.remove(cls));
  };
}
