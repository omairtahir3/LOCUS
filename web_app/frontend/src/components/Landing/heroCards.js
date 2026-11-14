import { Pill, KeyRound, MessageCircle, MapPin } from 'lucide-react';

// The cards that fly out of the camera's battery door, one per capability,
// each with a framed thumbnail (see Thumb in HeroStill.jsx, keyed by id).
// `cap` picks the capability colour (--lc-cap-*). `caption` is the line shown
// beside the scene while that card arrives.
export const HERO_CARDS = [
  {
    id: 'dose',
    cap: 'dose',
    icon: Pill,
    title: 'Dose verified',
    meta: 'Morning tablets, 8:02 am',
    status: 'Taken',
    caption: 'It sees the tablet reach the hand and keeps that frame as proof. When it is not sure, a caregiver is asked instead.',
  },
  {
    id: 'face',
    cap: 'face',
    initial: 'S',
    title: 'Sara, your daughter',
    meta: 'Seen at 10:40 am',
    caption: 'People you have named come back with their name and who they are to you.',
  },
  {
    id: 'keys',
    cap: 'item',
    icon: KeyRound,
    title: 'Keys: kitchen',
    meta: 'Put down at 9:12 am',
    caption: 'Belongings are recognised wherever they are put down, and remembered by room.',
  },
  {
    id: 'talk',
    cap: 'talk',
    icon: MessageCircle,
    title: 'Talked with Sara',
    meta: 'About Sunday lunch. You agreed to call on Friday.',
    caption: 'A conversation becomes a sentence or two to look back on. The audio is never kept.',
  },
  {
    id: 'home',
    cap: 'place',
    icon: MapPin,
    title: 'Home',
    meta: 'Since 6:15 pm',
    caption: 'The phone knows when they are home, and tells family when they are not.',
  },
];

// Scroll beats, as fractions of the hero's scroll length.
export const BEATS = {
  turn: [0.06, 0.24],     // camera turns to show its left side
  open: [0.22, 0.34],     // battery door swings open
  spill: [0.28, 0.38],    // warm light spills out
  cardStart: 0.36,        // cards fly out one after another...
  cardEnd: 0.8,           // ...sharing this span evenly
  cardsOut: [0.81, 0.84], // cards fade
  close: [0.83, 0.89],    // door closes...
  front: [0.89, 1],       // ...then the camera returns to its front view
};

export const cardWindow = (i, n) => {
  const span = (BEATS.cardEnd - BEATS.cardStart) / n;
  return [BEATS.cardStart + i * span, BEATS.cardStart + (i + 1) * span];
};

// Progress at which the scene shows its full composition (door open, every
// card settled), used as the still frame for reduced motion.
export const OPEN_STILL = 0.805;
