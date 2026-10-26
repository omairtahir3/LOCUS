import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

// A chest-worn action camera in the shape of a GoPro HERO13 Black, built from
// primitives: no model file, no licence, no logo artwork.
//
// ponytail: procedural rather than a GLB because none is in public/models. To
// swap one in, keep this component's contract: it reads rig.current.door
// (0 shut .. 1 open) and rig.current.spill (0 .. 1, light from the opening)
// each frame, and CameraModel.opening is the local point the cards fly out
// of (CameraModel.size gives W, H, D for framing). A GLB
// version would useGLTF() + useGLTF.preload() and drive its door node from
// the same two numbers; nothing outside this file changes.

// 72 x 51 x 34 mm, so 1.4 : 1 : 0.66. Front face is +z, left side is -x.
const W = 1.42, H = 1.0, D = 0.66;
const FRONT = D / 2, LEFT = -W / 2;
const DOOR = { h: 0.64, d: 0.34, t: 0.03 }; // battery door, flat part of the side
const OPENING = [LEFT - 0.06, 0, 0];

const AMBER = '#E9A23B';
const RUBBER = '#101012';

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  return new CanvasTexture(c);
}

export default function CameraModel({ rig }) {
  const door = useRef();
  const glow = useRef();
  const spillLight = useRef();
  const spillSprite = useRef();

  const tex = useMemo(() => {
    // Fine grip: low-contrast noise as a bump map on the rubber.
    const grip = canvasTexture(128, (g, s) => {
      const img = g.createImageData(s, s);
      for (let i = 0; i < img.data.length; i += 4) {
        const h = Math.sin(i * 12.9898) * 43758.5453; // deterministic noise
        const v = 110 + (h - Math.floor(h)) * 40;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    });
    grip.wrapS = grip.wrapT = RepeatWrapping;
    grip.repeat.set(6, 4);

    // Wordmark where the logo would be.
    const mark = canvasTexture(256, (g, s) => {
      g.fillStyle = '#9C968F';
      g.font = `700 ${s * 0.26}px "Bricolage Grotesque", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('LOCUS', s / 2, s / 2);
    });
    mark.colorSpace = SRGBColorSpace;

    // Warm light spilling from the door: a soft disc with faint rays.
    const spill = canvasTexture(256, (g, s) => {
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
    spill.colorSpace = SRGBColorSpace;
    return { grip, mark, spill };
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

  const rubber = <meshPhysicalMaterial color={RUBBER} roughness={0.85} envMapIntensity={0.45} bumpMap={tex.grip} bumpScale={0.6} />;
  const glass = (
    <meshPhysicalMaterial
      color="#15133A" roughness={0.04} metalness={0.5} clearcoat={1}
      iridescence={1} iridescenceIOR={1.3} iridescenceThicknessRange={[380, 520]}
    />
  );

  return (
    <group>
      {/* Body */}
      <RoundedBox args={[W, H, D]} radius={0.16} smoothness={6}>{rubber}</RoundedBox>

      {/* Front screen on the left half, nearly full height, LED above it and
          the wordmark low on the glass where the logo would be */}
      <RoundedBox args={[0.6, 0.8, 0.02]} radius={0.05} smoothness={3} position={[-0.33, -0.01, FRONT + 0.002]}>
        <meshPhysicalMaterial color="#060709" roughness={0.12} clearcoat={1} envMapIntensity={0.35} emissive="#1E2C3B" emissiveIntensity={0.15} />
      </RoundedBox>
      <mesh position={[-0.33, -0.29, FRONT + 0.014]}>
        <planeGeometry args={[0.3, 0.3]} />
        <meshBasicMaterial map={tex.mark} transparent />
      </mesh>
      <mesh position={[-0.33, 0.3, FRONT + 0.014]}>
        <boxGeometry args={[0.07, 0.022, 0.004]} />
        <meshBasicMaterial color={AMBER} />
      </mesh>

      {/* Lens on the right half: a large raised square housing, thick bezel,
          blue-violet coated glass with a small inner ring */}
      <group position={[0.38, 0.13, FRONT]}>
        <RoundedBox args={[0.6, 0.6, 0.16]} radius={0.12} smoothness={5} position={[0, 0, 0.04]}>
          <meshPhysicalMaterial color="#0E0E10" roughness={0.55} envMapIntensity={0.5} />
        </RoundedBox>
        <RoundedBox args={[0.46, 0.46, 0.02]} radius={0.07} smoothness={3} position={[0, 0, 0.12]}>
          <meshPhysicalMaterial color="#08080A" roughness={0.15} clearcoat={1} />
        </RoundedBox>
        <mesh rotation-x={Math.PI / 2} position={[0, 0, 0.14]}>
          <cylinderGeometry args={[0.19, 0.2, 0.04, 64]} />
          <meshPhysicalMaterial color="#1E1E22" roughness={0.35} metalness={0.3} />
        </mesh>
        <mesh position={[0, 0, 0.162]}>
          <circleGeometry args={[0.15, 64]} />
          {glass}
        </mesh>
        <mesh position={[0, 0, 0.164]}>
          <torusGeometry args={[0.08, 0.008, 12, 64]} />
          <meshStandardMaterial color="#4A4A55" metalness={1} roughness={0.25} />
        </mesh>
        <mesh position={[0, 0, 0.165]}>
          <circleGeometry args={[0.038, 32]} />
          <meshBasicMaterial color="#030305" />
        </mesh>
      </group>

      {/* Ribbed vent under the lens housing */}
      <group position={[0.38, -0.33, FRONT]}>
        <RoundedBox args={[0.54, 0.26, 0.04]} radius={0.03} smoothness={3} position={[0, 0, 0.01]}>
          {rubber}
        </RoundedBox>
        {[-0.2, -0.133, -0.067, 0, 0.067, 0.133, 0.2].map(x => (
          <mesh key={x} position={[x, 0, 0.032]}>
            <boxGeometry args={[0.022, 0.2, 0.012]} />
            <meshPhysicalMaterial color="#0B0B0D" roughness={0.7} />
          </mesh>
        ))}
      </group>

      {/* Rear touchscreen */}
      <RoundedBox args={[1.12, 0.8, 0.02]} radius={0.008} smoothness={2} position={[0, 0, -FRONT - 0.002]}>
        <meshPhysicalMaterial color="#090B0F" roughness={0.06} clearcoat={1} emissive="#1A2633" emissiveIntensity={0.3} />
      </RoundedBox>

      {/* Shutter on top, mode button on the right (lens) side */}
      <mesh position={[-0.25, H / 2 + 0.015, 0]}>
        <cylinderGeometry args={[0.11, 0.11, 0.04, 40]} />
        <meshPhysicalMaterial color="#26262B" roughness={0.5} />
      </mesh>
      <mesh rotation-z={Math.PI / 2} position={[W / 2 + 0.01, 0.18, 0.04]}>
        <cylinderGeometry args={[0.06, 0.06, 0.03, 32]} />
        <meshPhysicalMaterial color="#26262B" roughness={0.5} />
      </mesh>

      {/* Folding mounting fingers, deployed, with the screw hole through them */}
      <mesh position={[0, -H / 2 - 0.005, 0]}>
        <boxGeometry args={[0.34, 0.02, 0.38]} />
        <meshPhysicalMaterial color="#0C0C0E" roughness={0.9} />
      </mesh>
      {[-0.09, 0.09].map(x => (
        <RoundedBox key={x} args={[0.065, 0.26, 0.3]} radius={0.03} smoothness={3} position={[x, -H / 2 - 0.12, 0]}>
          {rubber}
        </RoundedBox>
      ))}
      <mesh rotation-z={Math.PI / 2} position={[0, -H / 2 - 0.17, 0]}>
        <cylinderGeometry args={[0.045, 0.045, 0.26, 24]} />
        <meshBasicMaterial color="#060607" />
      </mesh>

      {/* Battery bay on the left side: seam, glowing interior, battery */}
      <mesh position={[LEFT - 0.002, 0, 0]}>
        <boxGeometry args={[0.004, DOOR.h + 0.02, DOOR.d + 0.02]} />
        <meshBasicMaterial color="#050506" />
      </mesh>
      <mesh ref={glow} position={[LEFT - 0.004, 0, 0]}>
        <boxGeometry args={[0.004, DOOR.h - 0.02, DOOR.d - 0.02]} />
        <meshStandardMaterial color="#000" emissive={AMBER} emissiveIntensity={0} />
      </mesh>
      <mesh position={[LEFT - 0.007, -0.02, 0]}>
        <boxGeometry args={[0.004, DOOR.h - 0.14, DOOR.d - 0.1]} />
        <meshPhysicalMaterial color="#232120" roughness={0.6} />
      </mesh>
      <pointLight ref={spillLight} position={[LEFT - 0.45, 0, 0.1]} color={AMBER} intensity={0} distance={2.6} decay={2} />
      <sprite ref={spillSprite} position={[LEFT - 0.12, 0, 0]} visible={false}>
        <spriteMaterial map={tex.spill} transparent depthWrite={false} opacity={0} />
      </sprite>

      {/* The door, hinged on its front edge: pin, panel, latch */}
      <group ref={door} position={[LEFT - 0.006, 0, DOOR.d / 2]}>
        <mesh>
          <cylinderGeometry args={[0.016, 0.016, DOOR.h + 0.04, 16]} />
          <meshStandardMaterial color="#7A7A82" metalness={1} roughness={0.3} />
        </mesh>
        <RoundedBox args={[DOOR.t, DOOR.h, DOOR.d]} radius={0.012} smoothness={3} position={[-DOOR.t / 2, 0, -DOOR.d / 2]}>
          {rubber}
        </RoundedBox>
        <mesh position={[-DOOR.t - 0.004, 0, -DOOR.d + 0.06]}>
          <boxGeometry args={[0.01, 0.14, 0.05]} />
          <meshPhysicalMaterial color="#2E2E34" roughness={0.4} />
        </mesh>
      </group>
    </group>
  );
}

CameraModel.size = [W, H, D];
CameraModel.opening = OPENING;
