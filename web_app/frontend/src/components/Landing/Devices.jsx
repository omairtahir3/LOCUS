import { CheckCircle2, CircleHelp, MapPin, Pill, Bell, Activity, LayoutDashboard, Mic, Siren, ShieldCheck } from 'lucide-react';
import { Words } from './Effects';

// The caregiver dashboard and the wearer's phone app, drawn as tidy mockups
// in device frames (the restyled app screens do not exist yet, so these are
// not screenshots). Every element is something the app really shows.
// landingMotion.js tilts and parallaxes the two frames on desktop.
function Dashboard() {
  return (
    <div className="dev-screen dash">
      <aside>
        <b>LOCUS</b>
        {[[LayoutDashboard, 'Dashboard'], [Pill, 'Medications'], [Activity, 'Activity'], [MapPin, 'Location'], [Bell, 'Notifications']].map((item, i) => {
          const [Icon, t] = item;
          return <span key={t} className={i === 0 ? 'on' : undefined}><Icon size={13} /> {t}</span>;
        })}
      </aside>
      <div className="dash-main">
        <p className="dash-hello">Today</p>
        <div className="dash-tiles">
          <div><small>Doses</small><strong>2 of 3</strong><em className="mstatus mstatus--taken"><CheckCircle2 size={12} /> Taken</em></div>
          <div><small>Waiting for you</small><strong>1</strong><em className="mstatus mstatus--verify"><CircleHelp size={12} /> Awaiting confirmation</em></div>
          <div><small>Location</small><strong>Home</strong><em className="mstatus mstatus--taken"><MapPin size={12} /> Inside home area</em></div>
        </div>
        <ul className="dash-feed">
          <li><time>10:40</time> Saw Sara, your daughter</li>
          <li><time>09:12</time> Keys put down in the kitchen</li>
          <li><time>08:02</time> Morning tablets taken, frame kept</li>
        </ul>
      </div>
    </div>
  );
}

function Phone() {
  return (
    <div className="dev-screen phone">
      <p className="phone-hello">Good morning</p>
      <div className="phone-next">
        <small>Next reminder</small>
        <strong>Evening tablets</strong>
        <span>20:00</span>
      </div>
      <span className="phone-ask"><Mic size={16} /> Ask what happened</span>
      <span className="phone-sos"><Siren size={16} /> Help</span>
      <span className="phone-privacy"><ShieldCheck size={14} /> Privacy mode off</span>
    </div>
  );
}

export default function Devices({ thread }) {
  return (
    <section id="apps" className="lp-section lp-grid tone-plain devices" aria-labelledby="apps-title">
      {thread}
      <div className="devices-copy">
        <h2 id="apps-title" data-reveal><Words>On the phone, and on the dashboard</Words></h2>
        <p className="lp-lede" data-reveal>
          The person wearing it gets a calm phone app: today’s reminders, a way to ask what
          happened, and help one press away. The family gets a dashboard of how the day is going.
        </p>
      </div>
      <div className="devices-stage" aria-hidden="true">
        <div className="dev dev--laptop"><div className="dev-bar"><i /><i /><i /></div><Dashboard /></div>
        <div className="dev dev--phone"><Phone /></div>
      </div>
    </section>
  );
}
