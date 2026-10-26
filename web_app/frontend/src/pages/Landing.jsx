import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle2, CircleHelp, XCircle, CameraOff, Search, Mic, UserRound,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import HeroStill from '../components/Landing/HeroStill';
import { HERO_CARDS, BEATS, cardWindow, OPEN_STILL } from '../components/Landing/heroCards';
import './Landing.css';

// three, drei, gsap and lenis load only with the hero, never with the app.
const HeroScene = lazy(() => import('../components/Landing/HeroScene'));

function detect() {
  const mq = q => window.matchMedia(q).matches;
  let webgl = false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
      || document.createElement('canvas').getContext('webgl');
    webgl = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { /* no WebGL */ }
  return {
    webgl,
    still: mq('(prefers-reduced-motion: reduce)'),
    lite: mq('(max-width: 760px), (pointer: coarse)') || (navigator.hardwareConcurrency || 8) <= 4,
  };
}

// Falls back to the flat illustration if the 3D chunk or WebGL fails late.
class SceneBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const QUESTIONS = [
  'Did I take my tablets?',
  'Who was that?',
  'Where did I put my keys?',
  'What did we talk about?',
];

function Status({ kind, children }) {
  const Icon = { taken: CheckCircle2, verify: CircleHelp, missed: XCircle, off: CameraOff }[kind];
  return <span className={`mstatus mstatus--${kind}`}><Icon size={15} aria-hidden="true" />{children}</span>;
}

function MedsMock() {
  return (
    <div className="mock" role="img" aria-label="Today's doses: morning tablets taken, lunchtime awaiting confirmation, afternoon not counted because the camera was off, and yesterday evening's tablets not taken.">
      <p className="mock-title">Today's doses</p>
      <ul className="mock-list">
        <li><span className="mock-time">8:00</span><span>Morning tablets</span><Status kind="taken">Taken</Status></li>
        <li><span className="mock-time">13:00</span><span>With lunch</span><Status kind="verify">Awaiting confirmation</Status></li>
        <li><span className="mock-time">17:00</span><span>Vitamin D</span><Status kind="off">Camera was off</Status></li>
        <li><span className="mock-time">20:00</span><span>Evening tablets, yesterday</span><Status kind="missed">Not taken</Status></li>
      </ul>
    </div>
  );
}

function PeopleMock() {
  return (
    <div className="mock" role="img" aria-label="People seen today: Sara, your daughter, at 10:40 for 25 minutes; and someone not yet named, waiting for a caregiver to confirm.">
      <p className="mock-title">Seen today</p>
      <ul className="mock-list mock-people">
        <li><span className="mock-avatar">S</span><span><strong>Sara</strong><small>Your daughter, 10:40, for 25 minutes</small></span></li>
        <li><span className="mock-avatar mock-avatar--new"><UserRound size={18} /></span><span><strong>Not named yet</strong><small>A caregiver can confirm who this is</small></span></li>
      </ul>
    </div>
  );
}

function ItemsMock() {
  return (
    <div className="mock" role="img" aria-label="Searching belongings for keys: put down in the kitchen at 9:12 this morning.">
      <p className="mock-search"><Search size={16} aria-hidden="true" /> keys</p>
      <div className="mock-item">
        <span className="mock-thumb" />
        <span><strong>Keys</strong><small>Put down in the kitchen, today at 9:12</small></span>
      </div>
    </div>
  );
}

function AskMock() {
  return (
    <div className="mock" role="img" aria-label="Asking: what did I do this morning? The answer: you had breakfast in the kitchen, took your morning tablets at 8:02, and Sara came round at 10:40. You talked about Sunday lunch.">
      <p className="mock-ask"><Mic size={16} aria-hidden="true" /> What did I do this morning?</p>
      <p className="mock-answer">You had breakfast in the kitchen, took your morning tablets at 8:02, and Sara came round at 10:40. You talked about Sunday lunch.</p>
    </div>
  );
}

const CAPABILITIES = [
  {
    q: QUESTIONS[0],
    body: 'At each dose time it looks for three things in order: a tablet in the hand, the hand lifting, and the tablet gone. A clear sighting is logged with the frame that shows it. An unclear one goes to a caregiver to confirm, and a dose window that opens while the camera is off is held, not marked as missed.',
    mock: <MedsMock />,
  },
  {
    q: QUESTIONS[1],
    body: 'Faces are matched against the people the wearer has named, so a visit comes back as “Sara, your daughter” rather than a stranger. Nobody new is added until someone confirms who they are.',
    mock: <PeopleMock />,
  },
  {
    q: QUESTIONS[2],
    body: 'Photograph a belonging from a few angles when you set it up. After that the camera recognises it wherever it is put down and remembers which room it was in. Leave a room without it, and the phone says so.',
    mock: <ItemsMock />,
  },
  {
    q: QUESTIONS[3],
    body: 'Ask in your own words, by voice or by typing. The answer comes from what the camera saw and the short summaries it kept of each conversation.',
    mock: <AskMock />,
  },
];

const PRIVACY = [
  ['Video is analysed at home.', 'Every frame is looked at by a computer on your own network, and that is where the frames are kept. Video is not sent to the cloud.'],
  ['Saved frames are gone after 36 hours.', 'Evidence is deleted 36 hours after it was captured, unless a caregiver flags a frame to keep.'],
  ['No audio is stored.', 'Speech is transcribed in memory and the recording is thrown away. To write a short summary of a conversation, only the text is sent to a language model service.'],
  ['The wearer can stop it.', 'Privacy mode stops capture with one tap. Blurred capture blurs the whole frame before anything is saved, and rooms marked as sensitive have what was recorded there deleted.'],
];

export default function Landing() {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const [env] = useState(detect);
  const trackRef = useRef(null);
  const stageRef = useRef(null);
  const copyRef = useRef(null);
  const scroll = env.webgl && !env.still;
  const [state] = useState(() => (scroll ? { p: 0, intro: 0 } : { p: OPEN_STILL, intro: 1 }));
  const cards = env.lite ? HERO_CARDS.slice(0, 3) : HERO_CARDS;

  useEffect(() => {
    if (token && user)
      navigate(user.role === 'caregiver' || user.role === 'admin' ? '/dashboard' : '/my-dashboard');
  }, [token, user, navigate]);

  const still = <HeroStill cards={cards} />;

  return (
    <div className="lp">
      <nav className="lp-nav" aria-label="Main">
        <div className="lp-nav-inner">
          <Link to="/" className="lp-logo"><img src="/logo.png" alt="LOCUS" /></Link>
          <div className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#privacy">Privacy</a>
            <Link to="/login" className="lp-btn lp-btn--ghost">Sign in</Link>
            <Link to="/register" className="lp-btn">Create account</Link>
          </div>
        </div>
      </nav>

      <header className={`hero ${scroll ? 'hero--scroll' : 'hero--still'}`}>
        <div ref={trackRef} className="hero-track">
          <div ref={stageRef} className="hero-stage lp-grid" style={{ '--p': state.p }}>
            <div ref={copyRef} className="hero-copy">
              <h1>The day, remembered.</h1>
              <p>
                LOCUS is a small camera worn on the chest. A computer at home watches for the
                small moments that are easiest to lose, and answers when someone asks.
              </p>
              <div className="lp-actions">
                <Link to="/register" className="lp-btn lp-btn--lg">Create account</Link>
                <Link to="/login" className="lp-btn lp-btn--ghost lp-btn--lg">Sign in</Link>
              </div>
            </div>

            {scroll && (
              <div className="hero-captions">
                <p className="beat" style={{ '--a': -1, '--b': BEATS.turn[0] }}>
                  Scroll to look inside.
                </p>
                <p className="beat" style={{ '--a': BEATS.turn[0], '--b': BEATS.cardStart }}>
                  The camera only sees. Everything it notices is worked out on a computer at home.
                </p>
                {cards.map((c, i) => {
                  const [a, b] = cardWindow(i, cards.length);
                  return <p key={c.id} className="beat" style={{ '--a': a, '--b': b }}>{c.caption}</p>;
                })}
                <p className="beat" style={{ '--a': BEATS.cardsOut[0], '--b': 2 }}>
                  One small camera. Four questions it can answer.
                </p>
              </div>
            )}

            <div className="hero-visual" aria-hidden="true">
              {env.webgl ? (
                <SceneBoundary fallback={still}>
                  <Suspense fallback={scroll ? <HeroStill /> : still}>
                    <HeroScene state={state} cards={cards} lite={env.lite} scroll={scroll}
                      trackRef={trackRef} copyRef={copyRef} stageRef={stageRef} />
                  </Suspense>
                </SceneBoundary>
              ) : still}
            </div>
          </div>
        </div>
      </header>

      <main>
        <section className="lp-section lp-grid problem" aria-labelledby="problem-title">
          <h2 id="problem-title" className="lp-kicker">Four questions, asked again and again</h2>
          <ul className="problem-list">
            {QUESTIONS.map(q => <li key={q}>{q}</li>)}
          </ul>
          <p className="lp-lede">
            For someone living with dementia, the day fills up with small gaps. These are the ones
            that come back most, for them and for the family answering. LOCUS is built to answer
            these four, from what the camera actually saw.
          </p>
        </section>

        <section id="how" className="lp-section lp-grid lp-band lp-band--mint how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="how-steps">
            <li>
              <h3>The camera</h3>
              <p>Clipped to the chest, it streams over the home Wi‑Fi. It has no intelligence of its own.</p>
            </li>
            <li>
              <h3>A computer at home</h3>
              <p>Looks at each frame for tablets in a hand, faces the wearer knows, belongings and which room they are in.</p>
            </li>
            <li>
              <h3>The phone and the family</h3>
              <p>Reminders and answers reach the wearer’s phone. Anything that needs a person reaches the caregivers linked to them.</p>
            </li>
          </ol>
        </section>

        <section className="lp-section caps" aria-label="What LOCUS answers">
          {CAPABILITIES.map(c => (
            <article key={c.q} className="cap lp-grid">
              <h2 className="cap-q">{c.q}</h2>
              <p className="cap-body">{c.body}</p>
              <div className="cap-mock">{c.mock}</div>
            </article>
          ))}
        </section>

        <section id="privacy" className="lp-section lp-grid lp-band privacy" aria-labelledby="privacy-title">
          <h2 id="privacy-title">What it keeps, and what it doesn’t</h2>
          <dl className="privacy-list">
            {PRIVACY.map(([t, d]) => (
              <div key={t}><dt>{t}</dt><dd>{d}</dd></div>
            ))}
          </dl>
        </section>

        <section className="lp-section lp-grid who" aria-labelledby="who-title">
          <h2 id="who-title">Made for two people</h2>
          <div className="who-col">
            <h3>The person wearing it</h3>
            <p>
              A calm phone app with today’s reminders, a place to ask what happened, and help
              that is one press away, or a spoken phrase away when the phone is out of reach.
            </p>
          </div>
          <div className="who-col">
            <h3>The people who care for them</h3>
            <p>
              A dashboard that shows how the day is going: doses, anything waiting to be
              confirmed, where they are. Messages and voice calls go straight to them.
            </p>
          </div>
          <div className="lp-actions">
            <Link to="/register" className="lp-btn lp-btn--lg">Create account</Link>
            <Link to="/login" className="lp-btn lp-btn--ghost lp-btn--lg">Sign in</Link>
          </div>
        </section>
      </main>

      <footer className="lp-footer lp-grid lp-band">
        <img src="/logo.png" alt="LOCUS" />
        <p>A final-year project and research prototype. LOCUS is not a medical device.</p>
        <p>© 2026 LOCUS</p>
      </footer>
    </div>
  );
}
