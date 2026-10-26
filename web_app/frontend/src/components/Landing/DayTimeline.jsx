import { Thumb } from './HeroStill';
import { Words } from './Effects';

// Five moments from one day, each tied to a real capability. On desktop with
// motion allowed, landingMotion.js pins this section and steps .is-active
// through the list as you scroll; otherwise everything is simply listed.
const MOMENTS = [
  {
    id: 'dose', cap: 'dose', time: '08:02', title: 'Morning dose verified',
    text: 'A tablet in the hand, the hand lifting, the tablet gone. The frame that shows it is kept as evidence.',
  },
  {
    id: 'face', cap: 'face', time: '10:40', title: 'A visitor recognised',
    text: 'Sara, your daughter. A face the family has named comes back with a name and a relationship.',
  },
  {
    id: 'keys', cap: 'item', time: '12:15', title: 'Keys found',
    text: 'Asked where the keys went, LOCUS answers: put down in the kitchen at 9:12.',
  },
  {
    id: 'talk', cap: 'talk', time: '14:30', title: 'A conversation summarised',
    text: 'Talked with Sara about Sunday lunch, and agreed to call on Friday. The audio itself is never kept.',
  },
  {
    id: 'home', cap: 'place', time: '18:05', title: 'The walk home',
    text: 'Back inside the home area. Family are told when the wearer is away from home.',
  },
];

export default function DayTimeline() {
  return (
    <section id="day" className="lp-section lp-grid tone-tint day" aria-labelledby="day-title">
      <div className="day-intro">
        <h2 id="day-title" data-reveal><Words>A day with LOCUS</Words></h2>
        <p className="lp-lede" data-reveal>Five moments from one ordinary day, and what LOCUS made of each.</p>
        <ol className="day-list">
          {MOMENTS.map((m, i) => (
            <li key={m.id} className={i === 0 ? 'is-active' : undefined}>
              <time>{m.time}</time>
              <span>{m.title}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="day-stage">
        {MOMENTS.map((m, i) => (
          <article key={m.id} className={`day-card spot hcard--${m.cap}${i === 0 ? ' is-active' : ''}`} data-reveal>
            <Thumb id={m.id} />
            <div>
              <time>{m.time}</time>
              <h3>{m.title}</h3>
              <p>{m.text}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
