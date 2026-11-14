import { useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer } from '@react-three/drei';
import { Vector3 } from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import CameraModel from './CameraModel';
import { HeroCard } from './HeroStill';
import { BEATS, cardWindow } from './heroCards';

gsap.registerPlugin(ScrollTrigger);

const ease = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

const FOV = 26;
const FRONT_YAW = -0.7;        // three-quarter front, lens side, as in reference 2
const SIDE_YAW = 1.0;          // left side towards the viewer, door seen at an angle
// Where each card settles, in card order (degrees on an ellipse round the
// model): dose at the top, two at the upper sides, two below the camera so
// none of them covers it or the open door.
const ARC = { 5: [90, 150, 30, 218, -38], 3: [90, 158, 22] };

// Scroll position -> state.p, smoothed by Lenis. Mounted only when motion is
// allowed. Rendering is on demand, so an idle or off-screen hero costs nothing.
function ScrollDriver({ trackRef, copyRef, stageRef, state }) {
  const invalidate = useThree(s => s.invalidate);

  useEffect(() => {
    const lenis = new Lenis({ anchors: true });
    const raf = t => lenis.raf(t * 1000);
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    // Stacked layout: the copy scrolls past first, then the scene scrubs.
    const stacked = window.matchMedia('(max-width: 899px)');
    const trigger = ScrollTrigger.create({
      trigger: trackRef.current,
      start: () => (stacked.matches ? `top+=${copyRef.current?.offsetHeight || 0} top` : 'top top'),
      end: 'bottom bottom',
      invalidateOnRefresh: true,
      onUpdate: self => {
        state.p = self.progress;
        stageRef.current?.style.setProperty('--p', self.progress.toFixed(4));
        invalidate();
      },
    });
    const intro = gsap.to(state, { intro: 1, duration: 1.6, ease: 'power3.out', onUpdate: invalidate });

    return () => {
      intro.kill();
      trigger.kill();
      gsap.ticker.remove(raf);
      gsap.ticker.lagSmoothing(500, 33);
      lenis.destroy();
    };
  }, [trackRef, copyRef, stageRef, state, invalidate]);

  return null;
}

function Scene({ state, cards, cardEls, lite }) {
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
  const invalidate = useThree(s => s.invalidate);

  // Pointer over the camera turns it: across the full width is half a turn
  // either way, so the edges show the rear screen. Eases back on leave.
  const gl = useThree(s => s.gl);
  const look = useRef({ x: 0, y: 0, yaw: 0, tilt: 0 });
  useEffect(() => {
    const el = gl.domElement;
    const move = e => {
      const r = el.getBoundingClientRect();
      look.current.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      look.current.y = ((e.clientY - r.top) / r.height) * 2 - 1;
      invalidate();
    };
    const leave = () => { look.current.x = look.current.y = 0; invalidate(); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointercancel', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointercancel', leave);
    };
  }, [gl, invalidate]);

  // Card sizes change when the web fonts arrive and when the panel resizes,
  // and at no other time, so they are measured then and cached. Reading them
  // per frame instead forced a layout flush on every frame of the scroll.
  // size is the canvas size from useThree, so this re-runs on a resize too.
  const sizes = useRef([]);
  useEffect(() => {
    const measure = () => {
      sizes.current = cardEls.current.map(el => (el ? [el.offsetWidth, el.offsetHeight] : [0, 0]));
      invalidate();
    };
    measure();
    document.fonts?.ready.then(measure);
  }, [cardEls, invalidate, size]);
  const rigGroup = useRef();
  const rig = useRef({ door: 0, spill: 0 });
  const v = useRef(new Vector3());

  // Fit the camera so the model takes a steady share of the panel, sitting a
  // little below centre to leave room for the arc of cards above it.
  useEffect(() => {
    const [w, h] = CameraModel.size;
    const aspect = size.width / size.height;
    const tan = Math.tan((FOV * Math.PI) / 360);
    const dist = Math.max((w / 0.36) / 2 / (tan * aspect), (h / 0.3) / 2 / tan);
    // Centred on the hero copy beside it rather than sitting low in the panel.
    const lookY = -0.04 * dist * tan;
    camera.position.set(0, lookY + dist * 0.14, dist);
    camera.lookAt(0, lookY, 0);
    camera.updateProjectionMatrix();
  }, [camera, size]);

  useFrame(({ size: s }, delta) => {
    const { p, intro } = state;
    const L = look.current;
    const k = 1 - Math.exp(-Math.min(delta, 1 / 30) * 7);
    L.yaw += (L.x * Math.PI - L.yaw) * k;
    L.tilt += (L.y * 0.35 - L.tilt) * k;
    if (Math.abs(L.x * Math.PI - L.yaw) + Math.abs(L.y * 0.35 - L.tilt) > 0.002) invalidate();
    const turn = ease(...BEATS.turn, p) * (1 - ease(...BEATS.front, p));
    rig.current.door = ease(...BEATS.open, p) * (1 - ease(...BEATS.close, p));
    rig.current.spill = ease(...BEATS.spill, p) * (1 - ease(...BEATS.close, p));

    const g = rigGroup.current;
    g.rotation.y = lerp(lerp(-1.3, FRONT_YAW, intro), SIDE_YAW, turn) + L.yaw;
    g.rotation.x = lerp(0.2, 0.1, turn) + L.tilt;  // seen from a little above, as in the photos
    // Larger on its own; steps back while the cards are out.
    g.scale.setScalar(lerp(1.55, 1.2, ease(BEATS.turn[0], BEATS.cardStart, p) * (1 - ease(...BEATS.front, p))));
    g.position.y = lerp(-0.12, 0, intro);
    g.updateMatrixWorld();

    // Project the model's centre and the door opening to panel pixels.
    const px = local => {
      v.current.fromArray(local).applyMatrix4(g.matrixWorld).project(camera);
      return [(v.current.x + 1) / 2 * s.width, (1 - v.current.y) / 2 * s.height];
    };
    const [cx, cy] = px([0, 0, 0]);
    const [ox, oy] = px(CameraModel.opening);
    const angles = ARC[cards.length] || ARC[5];
    const out = 1 - ease(...BEATS.cardsOut, p);

    // Where each card settles: on an ellipse round the model, inside the
    // panel. Then pull apart any two that overlap (narrow panels), sideways
    // first, then down, so no card covers another.
    const T = cards.map((card, i) => {
      const [cw, ch] = sizes.current[i] || [0, 0];
      const rx = Math.max(0, Math.min(cx, s.width - cx) - cw / 2 - 12);
      const ry = Math.max(0, cy - ch / 2 - 16);
      const ang = (angles[i] * Math.PI) / 180;
      return { x: cx + Math.cos(ang) * rx, y: cy - Math.sin(ang) * ry, w: cw, h: ch };
    });
    const clampX = t => Math.min(Math.max(t.x, t.w / 2 + 8), s.width - t.w / 2 - 8);
    for (let i = 0; i < T.length; i++) {
      for (let j = i + 1; j < T.length; j++) {
        const A = T[i], B = T[j];
        const dx = (A.w + B.w) / 2 + 8 - Math.abs(A.x - B.x);
        const dy = (A.h + B.h) / 2 + 8 - Math.abs(A.y - B.y);
        if (dx <= 0 || dy <= 0) continue;
        const dir = B.x >= A.x ? 1 : -1;
        A.x = clampX({ ...A, x: A.x - (dir * dx) / 2 });
        B.x = clampX({ ...B, x: B.x + (dir * dx) / 2 });
        const left = (A.w + B.w) / 2 + 8 - Math.abs(A.x - B.x);
        if (left > 0) B.y += (B.y >= A.y ? 1 : -1) * dy;
      }
    }

    cards.forEach((card, i) => {
      const el = cardEls.current[i];
      if (!el) return;
      const [a, b] = cardWindow(i, cards.length);
      const q = ease(a, a + (b - a) * 0.85, p);
      const opacity = Math.min(1, q * 3) * out;
      el.style.visibility = opacity < 0.01 ? 'hidden' : 'visible';
      if (opacity < 0.01) return;

      const t = T[i];
      const tx = t.x, ty = Math.min(Math.max(t.y, t.h / 2 + 8), s.height - t.h / 2 - 8);
      // Curved path: a quadratic bend lifted above the straight line.
      const kx = (ox + tx) / 2, ky = Math.min(oy, ty) - s.height * 0.12;
      const x = (1 - q) ** 2 * ox + 2 * (1 - q) * q * kx + q * q * tx;
      const y = (1 - q) ** 2 * oy + 2 * (1 - q) * q * ky + q * q * ty;
      el.style.opacity = opacity.toFixed(3);
      el.style.transform =
        `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${(0.25 + 0.75 * q).toFixed(3)})`;
    });
  }, -1); // runs before the model reads rig, so a demand render is never a frame behind

  return (
    <>
      {/* Bright, neutral studio: soft boxes for reflections on the black body */}
      <Environment resolution={lite ? 48 : 128} frames={1}>
        <color attach="background" args={['#E8E3DA']} />
        <Lightformer form="rect" intensity={3} position={[0, 5, 2]} scale={[8, 4, 1]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={2} position={[-5, 1, 2]} scale={[2, 5, 1]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.5} position={[5, 1, 1]} scale={[2, 5, 1]} rotation-y={-Math.PI / 2} />
      </Environment>

      <hemisphereLight args={['#FFFFFF', '#D9D0C3', 1.1]} />
      <directionalLight position={[2.5, 4, 3]} intensity={1.6} />
      {!lite && <directionalLight position={[-3, 1.5, 2]} intensity={0.6} />}
      {!lite && <directionalLight position={[0, 2, -4]} intensity={1.2} />}

      <group ref={rigGroup}>
        <CameraModel rig={rig} lite={lite} />
      </group>

      <ContactShadows position={[0, -0.76, 0]} opacity={0.42} scale={5} blur={2.4} far={1.4}
        resolution={lite ? 128 : 256} color="#2B2219" />
    </>
  );
}

// The lazy-loaded 3D hero. `state` is a plain object ({ p, intro }) shared
// with the page: the scroll driver writes it, the scene reads it per frame.
// The cards are DOM, positioned by the scene each frame, so text stays crisp.
// The canvas has no background: the page ground and its light pool show through.
export default function HeroScene({ state, cards, lite, scroll, trackRef, copyRef, stageRef }) {
  const cardEls = useRef([]);
  return (
    <>
      <Canvas
        className="hero-canvas"
        flat
        frameloop="demand"
        dpr={lite ? [1, 1.25] : [1, 1.5]}
        camera={{ fov: FOV, near: 0.1, far: 60, position: [0, 0, 8] }}
        gl={{ antialias: true, powerPreference: lite ? 'low-power' : 'high-performance' }}
      >
        <Scene state={state} cards={cards} cardEls={cardEls} lite={lite} />
        {scroll && <ScrollDriver trackRef={trackRef} copyRef={copyRef} stageRef={stageRef} state={state} />}
      </Canvas>
      <div className="hero-cards">
        {cards.map((c, i) => (
          <div key={c.id} ref={el => (cardEls.current[i] = el)} className="hcard-wrap" style={{ visibility: 'hidden' }}>
            <HeroCard card={c} />
          </div>
        ))}
      </div>
    </>
  );
}
