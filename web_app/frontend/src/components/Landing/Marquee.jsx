import { Pill, ScanFace, Package, MessageCircle, Search, MapPin, ShieldCheck, Siren, PhoneCall, Footprints } from 'lucide-react';

// What LOCUS does, as a calm looping strip of chips. The list is shown twice
// so the loop is seamless; the copy is hidden from assistive tech. CSS pauses
// it on hover, off-screen ([data-loop]) and for reduced motion.
const CHIPS = [
  [Pill, 'Dose verification'],
  [ScanFace, 'Face recognition'],
  [Package, 'Belonging tracking'],
  [MessageCircle, 'Conversation summaries'],
  [Search, 'Memory search'],
  [MapPin, 'Location safety'],
  [Footprints, 'Fall detection'],
  [Siren, 'Emergency alerts'],
  [PhoneCall, 'Voice calls'],
  [ShieldCheck, 'Privacy mode'],
];

export default function Marquee() {
  const list = hidden => (
    <ul className="marquee-list" aria-hidden={hidden || undefined}>
      {CHIPS.map(chip => {
        const [Icon, label] = chip;
        return <li key={label}><Icon size={16} aria-hidden="true" /> {label}</li>;
      })}
    </ul>
  );
  return (
    <div className="marquee" data-loop>
      <div className="marquee-track">{list(false)}{list(true)}</div>
    </div>
  );
}
