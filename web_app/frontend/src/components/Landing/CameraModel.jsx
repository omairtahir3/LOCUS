import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import {
  BoxGeometry, CanvasTexture, MeshBasicMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, RepeatWrapping, SRGBColorSpace,
} from 'three';

// A chest-worn action camera modelled on the GoPro HERO13 Black reference
// photos (references/): built from primitives, no model file, no licence,
// no GoPro logo artwork (a plain LOCUS wordmark sits in the logo area).
//
// ponytail: procedural rather than a GLB because none is in public/models. To
// swap one in, keep this component's contract: it reads rig.current.door
// (0 shut .. 1 open) and rig.current.spill (0 .. 1, light from the opening)
// each frame, and CameraModel.opening is the local point the cards fly out
// of (CameraModel.size gives W, H, D for framing). A GLB version would
// useGLTF() + useGLTF.preload() and drive its door node from the same two
// numbers; nothing outside this file changes.
//
// Units: body height = 1. Front face is +z; the lens is on the +x side; the
// battery door is on the -x side, opposite the mode button. Positions below
// were measured off the front reference photo.

const W = 1.42, H = 1.0, D = 0.66;  // 72 x 51 x 34 mm
const FRONT = D / 2, BACK = -D / 2, LEFT = -W / 2, RIGHT = W / 2;
const DOOR = { h: 0.66, d: 0.36, t: 0.018 };  // near flush with the side
const OPENING = [LEFT - 0.06, 0, 0];

const AMBER = '#E9A23B';
const RUBBER = '#0A0A0B';  // matte black: little env and specular so it stays black in a bright studio

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

// The underwater shot shown on both screens in the reference photos, drawn
// rather than copied: dark rock at the top, light rays into blue water.
function drawScene(g, w, h) {
  const water = g.createLinearGradient(0, 0, 0, h);
  water.addColorStop(0, '#4A3426');
  water.addColorStop(0.28, '#5E7A7E');
  water.addColorStop(0.5, '#1E7FA0');
  water.addColorStop(1, '#0A3E5E');
  g.fillStyle = water;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#5A4232';                      // rock overhang
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(w, 0);
  g.lineTo(w, h * 0.16);
  for (let i = 10; i >= 0; i--) {
    g.lineTo((w * i) / 10, h * (0.18 + 0.06 * Math.sin(i * 2.3) + 0.03 * Math.cos(i * 5.1)));
  }
  g.closePath();
  g.fill();
  g.save();                                     // light rays, soft
  g.filter = 'blur(4px)';
  g.translate(w * 0.5, h * 0.22);
  for (let i = -5; i <= 5; i++) {
    const ray = g.createLinearGradient(0, 0, 0, h);
    ray.addColorStop(0, 'rgba(225,248,255,0.22)');
    ray.addColorStop(1, 'rgba(225,248,255,0)');
    g.fillStyle = ray;
    g.beginPath();
    g.moveTo(i * w * 0.02 - 3, 0);
    g.lineTo(i * w * 0.11 - w * 0.025, h);
    g.lineTo(i * w * 0.11 + w * 0.025, h);
    g.lineTo(i * w * 0.02 + 3, 0);
    g.fill();
  }
  g.restore();
}

// Both screens are the same material with a different picture in the
// emissive slot.
const screenMat = map => new MeshPhysicalMaterial({
  color: '#000', emissive: '#FFF', emissiveMap: map, emissiveIntensity: 0.92,
  roughness: 0.12, clearcoat: 1, envMapIntensity: 0.25,
});

const RIBS = 13;          // vent slats under the lens module
const RIB_X = i => -0.264 + i * 0.044;

export default function CameraModel({ rig, lite = false }) {
  const door = useRef();
  const glow = useRef();
  const spillLight = useRef();
  const spillSprite = useRef();

  const tex = useMemo(() => {
    // Fine grip on the rubber: deterministic low-contrast noise as a bump map.
    const grip = canvasTexture(96, 96, (g, s) => {
      const img = g.createImageData(s, s);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = Math.sin(i * 12.9898) * 43758.5453;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 110 + (n - Math.floor(n)) * 40;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    });
    grip.wrapS = grip.wrapT = RepeatWrapping;
    grip.repeat.set(6, 4);

    // Front screen: picture on top, the wordmark below it where the logo is.
    const front = canvasTexture(192, 246, (g, w, h) => {
      g.fillStyle = '#05070A';
      g.fillRect(0, 0, w, h);
      g.save();
      g.beginPath();
      g.roundRect(0, 0, w, h * 0.7, 10);
      g.clip();
      drawScene(g, w, h * 0.7);
      g.restore();
      g.fillStyle = '#D5DADF';
      g.font = `700 ${w * 0.16}px "Space Grotesk", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('LOCUS', w / 2, h * 0.85);
    });

    // Rear touchscreen: the same picture with the camera's status overlay.
    const rear = canvasTexture(320, 210, (g, w, h) => {
      drawScene(g, w, h);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(0, 0, w, 44);
      g.font = '600 15px system-ui, sans-serif';
      g.textBaseline = 'middle';
      const battery = (x, label) => {
        g.strokeStyle = '#FFF';
        g.lineWidth = 2;
        g.strokeRect(x, 14, 30, 16);
        g.fillStyle = '#4BD06B';
        g.fillRect(x + 3, 17, 24, 10);
        g.fillStyle = '#FFF';
        g.fillText(label, x + 38, 23);
      };
      battery(18, '9H:59');
      battery(w - 118, '100%');
      g.fillStyle = '#E5332A';
      g.beginPath();
      g.roundRect(w / 2 - 38, 10, 76, 26, 13);
      g.fill();
      g.fillStyle = '#FFF';
      g.textAlign = 'center';
      g.fillText('00:13', w / 2, 23);
    });

    // Warm light spilling from the door: a soft disc with faint rays.
    const spill = canvasTexture(192, 192, (g, s) => {
      const r = s / 2;
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(255,214,150,0.95)');
      grad.addColorStop(0.35, 'rgba(233,162,59,0.45)');
      grad.addColorStop(1, 'rgba(233,162,59,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
      g.translate(r, r);
      for (let i = 0; i < 9; i++) {
        g.rotate((Math.PI * 2) / 9 + (i % 2) * 0.2);
        const ray = g.createLinearGradient(0, 0, r, 0);
        ray.addColorStop(0, 'rgba(255,220,160,0.35)');
        ray.addColorStop(1, 'rgba(255,220,160,0)');
        g.fillStyle = ray;
        g.beginPath();
        g.moveTo(0, -2);
        g.lineTo(r, -10);
        g.lineTo(r, 10);
        g.lineTo(0, 2);
        g.fill();
      }
    });
    return { grip, front, rear, spill };
  }, []);

  useEffect(() => () => Object.values(tex).forEach(t => t.dispose()), [tex]);

  useFrame(() => {
    const { door: open, spill } = rig.current;
    door.current.rotation.y = open * 1.75;            // about 100 degrees
    glow.current.material.emissiveIntensity = spill * 1.1;
    spillLight.current.intensity = spill * 1.6;
    spillSprite.current.material.opacity = spill * 0.55;
    spillSprite.current.scale.setScalar(0.4 + spill * 1.1);
    spillSprite.current.visible = spill > 0.01;
  });

  // One material instance per surface, shared by every part that uses it.
  // These were JSX elements held in consts and dropped into several meshes,
  // which reads as sharing but is not one: React mounts a separate material
  // for each place an element appears, so the rubber alone existed five times
  // over, each with its own copy of the uniforms.
  const mats = useMemo(() => ({
    rubber: new MeshPhysicalMaterial({
      color: RUBBER, roughness: 0.62, envMapIntensity: 0.16,
      specularIntensity: 0.45, bumpMap: tex.grip, bumpScale: 0.4,
    }),
    gloss: new MeshPhysicalMaterial({
      color: '#050506', roughness: 0.06, clearcoat: 1, envMapIntensity: 0.9,
    }),
    front: screenMat(tex.front),
    rear: screenMat(tex.rear),
    led: new MeshBasicMaterial({ color: '#E5332A' }),
    barrel: new MeshPhysicalMaterial({ color: '#0B0B0D', roughness: 0.45 }),
    ring: new MeshStandardMaterial({ color: '#3A3A40', metalness: 1, roughness: 0.3 }),
    // Iridescence is the most expensive shader in the scene. It is the lens
    // coating and worth it on a machine that can afford it; on one that
    // cannot, a plain clearcoat reads nearly the same at this size.
    dome: lite
      ? new MeshPhysicalMaterial({
          color: '#16123A', roughness: 0.05, metalness: 0.6, clearcoat: 1,
        })
      : new MeshPhysicalMaterial({
          color: '#16123A', roughness: 0.03, metalness: 0.5, clearcoat: 1,
          iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [380, 520],
        }),
    ringSmall: new MeshStandardMaterial({ color: '#5A5A66', metalness: 1, roughness: 0.25 }),
    ventBase: new MeshBasicMaterial({ color: '#060607' }),
    rib: new MeshPhysicalMaterial({ color: '#202023', roughness: 0.7 }),
    shutter: new MeshPhysicalMaterial({ color: '#1C1C1F', roughness: 0.7, envMapIntensity: 0.3 }),
    modeBtn: new MeshPhysicalMaterial({ color: '#202024', roughness: 0.6 }),
    modeRing: new MeshBasicMaterial({ color: '#8A8A92' }),
    mountPlate: new MeshPhysicalMaterial({ color: '#0E0E10', roughness: 0.9 }),
    seam: new MeshBasicMaterial({ color: '#050506' }),
    glow: new MeshStandardMaterial({ color: '#000', emissive: AMBER, emissiveIntensity: 0 }),
    bayInner: new MeshPhysicalMaterial({ color: '#232120', roughness: 0.6 }),
    hinge: new MeshStandardMaterial({ color: '#7A7A82', metalness: 1, roughness: 0.3 }),
    latch: new MeshPhysicalMaterial({ color: '#2E2E34', roughness: 0.4 }),
  }), [tex, lite]);

  useEffect(() => () => Object.values(mats).forEach(m => m.dispose()), [mats]);

  // The vent slats: thirteen meshes over ONE box geometry and ONE material,
  // where before each was a RoundedBox extruding its own geometry and
  // mounting its own material. They are 0.026 wide, so the rounding was never
  // visible. Thirteen draw calls of twelve triangles cost nothing; thirteen
  // extrusions did.
  const ribGeo = useMemo(() => new BoxGeometry(0.026, 0.2, 0.014), []);
  useEffect(() => () => ribGeo.dispose(), [ribGeo]);

  return (
    <group>
      {/* Body */}
      <RoundedBox args={[W, H, D]} radius={0.12} smoothness={4} bevelSegments={2}
        material={mats.rubber} />

      {/* Front screen, left half: black glass bezel, lit display, red LED */}
      <RoundedBox args={[0.62, 0.82, 0.016]} radius={0.006} smoothness={2} bevelSegments={1}
        position={[-0.3, 0, FRONT + 0.004]} material={mats.gloss} />
      <mesh position={[-0.296, -0.02, FRONT + 0.0135]} material={mats.front}>
        <planeGeometry args={[0.53, 0.68]} />
      </mesh>
      <mesh position={[-0.29, 0.355, FRONT + 0.014]} material={mats.led}>
        <planeGeometry args={[0.1, 0.024]} />
      </mesh>

      {/* Lens module, flush with the top-right corner, standing proud */}
      <group position={[0.394, 0.18, FRONT]}>
        <RoundedBox args={[0.676, 0.652, 0.2]} radius={0.1} smoothness={4} bevelSegments={2}
          position={[0, 0, 0.06]} material={mats.rubber} />
        <RoundedBox args={[0.545, 0.55, 0.02]} radius={0.07} smoothness={3} bevelSegments={1}
          position={[0, 0.007, 0.162]} material={mats.gloss} />
        <group position={[-0.024, -0.004, 0.172]}>
          <mesh rotation-x={Math.PI / 2} position={[0, 0, 0.012]} material={mats.barrel}>
            <cylinderGeometry args={[0.21, 0.215, 0.024, 32]} />
          </mesh>
          <mesh position={[0, 0, 0.025]} material={mats.ring}>
            <torusGeometry args={[0.178, 0.012, 10, 36]} />
          </mesh>
          {/* coated glass dome with the blue-violet reflection: a sphere cap
              0.17 across its base and 0.05 high, seated in the ring */}
          <mesh rotation-x={Math.PI / 2} position={[0, 0, -0.249]} material={mats.dome}>
            <sphereGeometry args={[0.314, 36, 10, 0, Math.PI * 2, 0, 0.572]} />
          </mesh>
          <mesh position={[0, 0, 0.058]} material={mats.ringSmall}>
            <torusGeometry args={[0.07, 0.006, 8, 24]} />
          </mesh>
        </group>
      </group>

      {/* Ribbed vent under the lens module */}
      <group position={[0.425, -0.28, FRONT]}>
        <RoundedBox args={[0.57, 0.24, 0.03]} radius={0.012} smoothness={2} bevelSegments={1}
          position={[0, 0, 0.004]} material={mats.ventBase} />
        {Array.from({ length: RIBS }, (_, i) => (
          <mesh key={i} position={[RIB_X(i), 0, 0.02]}
            geometry={ribGeo} material={mats.rib} />
        ))}
      </group>

      {/* Rear touchscreen, almost the whole back */}
      <RoundedBox args={[1.3, 0.86, 0.016]} radius={0.006} smoothness={2} bevelSegments={1}
        position={[0, 0, BACK - 0.004]} material={mats.gloss} />
      <mesh rotation-y={Math.PI} position={[0, 0, BACK - 0.0135]} material={mats.rear}>
        <planeGeometry args={[1.2, 0.79]} />
      </mesh>

      {/* Shutter on top above the screen; mode button on the lens side */}
      <RoundedBox args={[0.3, 0.05, 0.22]} radius={0.024} smoothness={3} bevelSegments={1}
        position={[-0.26, H / 2 + 0.008, 0]} material={mats.shutter} />
      <group position={[RIGHT + 0.006, 0.16, 0.12]} rotation-z={Math.PI / 2}>
        <mesh material={mats.modeBtn}>
          <cylinderGeometry args={[0.085, 0.085, 0.02, 24]} />
        </mesh>
        <mesh position={[0, 0.011, 0]} rotation-x={-Math.PI / 2} material={mats.modeRing}>
          <torusGeometry args={[0.035, 0.005, 6, 24, Math.PI * 1.6]} />
        </mesh>
      </group>

      {/* Mounting fingers folded flat into the bottom, as in the photos */}
      <mesh position={[0, -H / 2 - 0.002, 0]} material={mats.mountPlate}>
        <boxGeometry args={[0.5, 0.006, 0.4]} />
      </mesh>
      {[-0.1, 0.1].map(x => (
        <RoundedBox key={x} args={[0.07, 0.014, 0.34]} radius={0.006} smoothness={2} bevelSegments={1}
          position={[x, -H / 2 - 0.006, 0]} material={mats.rubber} />
      ))}

      {/* Battery bay on the left side: seam, glowing interior, battery */}
      <mesh position={[LEFT - 0.002, 0, 0]} material={mats.seam}>
        <boxGeometry args={[0.004, DOOR.h + 0.02, DOOR.d + 0.02]} />
      </mesh>
      <mesh ref={glow} position={[LEFT - 0.004, 0, 0]} material={mats.glow}>
        <boxGeometry args={[0.004, DOOR.h - 0.02, DOOR.d - 0.02]} />
      </mesh>
      <mesh position={[LEFT - 0.007, -0.02, 0]} material={mats.bayInner}>
        <boxGeometry args={[0.004, DOOR.h - 0.14, DOOR.d - 0.1]} />
      </mesh>
      <pointLight ref={spillLight} position={[LEFT - 0.45, 0, 0.1]} color={AMBER} intensity={0} distance={2.6} decay={2} />
      <sprite ref={spillSprite} position={[LEFT - 0.12, 0, 0]} visible={false}>
        <spriteMaterial map={tex.spill} transparent depthWrite={false} opacity={0} />
      </sprite>

      {/* The door, hinged on its front edge: pin, panel, latch */}
      <group ref={door} position={[LEFT - 0.006, 0, DOOR.d / 2]}>
        <mesh material={mats.hinge}>
          <cylinderGeometry args={[0.016, 0.016, DOOR.h + 0.04, 10]} />
        </mesh>
        <RoundedBox args={[DOOR.t, DOOR.h, DOOR.d]} radius={0.012} smoothness={2} bevelSegments={1}
          position={[-DOOR.t / 2, 0, -DOOR.d / 2]} material={mats.rubber} />
        <mesh position={[-DOOR.t - 0.004, 0, -DOOR.d + 0.06]} material={mats.latch}>
          <boxGeometry args={[0.01, 0.14, 0.05]} />
        </mesh>
      </group>
    </group>
  );
}

CameraModel.size = [W, H, D];
CameraModel.opening = OPENING;
