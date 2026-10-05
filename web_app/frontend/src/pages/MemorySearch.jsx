import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Search, Shield, Mic, SearchX, Footprints, User, Pill, Hospital, ShoppingCart, Video, Camera, Pin, MapPin, Activity, Package, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { eventLogsAPI, detectionAPI, relationshipsAPI, userItemsAPI } from '../services/api';
import { formatClockTime } from '../utils/dateUtils';

const FILTERS = ['All', 'Medicine', 'People', 'Activity', 'Objects'];

// How often today's memories are re-fetched while the tab is visible. The query
// behind it measures 6-8 ms and the images are immutable-cached, so a poll
// costs a request and almost nothing else; 15 s is well inside the time it
// takes to put something down and walk back.
const REFRESH_MS = 15000;

/** Local YYYY-MM-DD. toISOString() would shift the day by the UTC offset. */
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = localDay();
const shiftDay = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d);
  x.setDate(x.getDate() + days);
  return localDay(x);
};

export default function MemorySearch() {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  // Full-image viewer. Thumbnails are cropped to 100px with objectFit:cover,
  // so the evidence frame can't be read without opening it full size.
  const [lightbox, setLightbox] = useState(null);
  // Keyframes are deleted once they pass their retention window (FE-8), so a
  // memory routinely outlives its picture. Recording the failures in state and
  // re-rendering the NO-IMAGE layout keeps those cards identical to ones that
  // never had a frame. Hiding just the thumbnail in the DOM left the
  // with-image wrapper behind, and the text sat indented differently from its
  // neighbours.
  const [brokenImages, setBrokenImages] = useState(() => new Set());
  const markImageBroken = (id) =>
    setBrokenImages((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  // Asking, as opposed to filtering. Typing still narrows the day on screen,
  // which is unchanged. Pressing Enter or speaking sends the question to the
  // agent, which answers from the whole record rather than the rows loaded.
  const [answer, setAnswer] = useState(null);
  // A frame can be deleted between the answer being written and the image being
  // fetched, and an <img> that 404s leaves an empty box that reads as a photo
  // which failed to load rather than one that no longer exists. The backend
  // already withholds ids past the retention window; this is the race.
  const [answerImageBroken, setAnswerImageBroken] = useState(false);
  const [asking, setAsking] = useState(false);
  const [listening, setListening] = useState(false);
  // ponytail: the browser's own SpeechRecognition, no speech SDK and no audio
  // upload. Recognition happens on the device and only the resulting text
  // leaves it. Chrome and Edge expose it prefixed; Firefox has neither, which
  // is why the button is feature-detected rather than shown and failing.
  const Speech = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);

  const askAgent = async (q) => {
    const text = String(q || '').trim();
    if (!text) return;
    setAsking(true);
    setAnswerImageBroken(false);
    try {
      const res = await eventLogsAPI.ask(text);
      setAnswer(res.data && res.data.answer ? res.data : null);
    } catch (e) {
      console.error('Failed to answer question:', e);
      setAnswer(null);
    } finally {
      setAsking(false);
    }
  };

  const listen = () => {
    if (!Speech || listening) return;
    const rec = new Speech();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      const said = ev.results[0][0].transcript;
      setQuery(said);
      askAgent(said);
    };
    // onend fires after onerror too, so clearing the flag in both is harmless
    // and covers a denied microphone, which emits no result at all.
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  };

  // A day at a time, like the Activity Feed. "All days" keeps the old
  // behaviour of showing the most recent memories regardless of date.
  const [date, setDate] = useState(todayStr);

  // Narrowing by WHO or by WHAT (FE 6-3). Empty string means "everyone" /
  // "everything", which is the state the page has always been in.
  const [personId, setPersonId] = useState('');
  const [itemId, setItemId] = useState('');
  const [people, setPeople] = useState([]);
  const [things, setThings] = useState([]);

  // `quiet` refreshes in place, without the spinner: a background poll that
  // blanks the list every few seconds is worse than not polling at all.
  const fetchEvents = async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      // No limit when a day is chosen: every memory from that day is the
      // point of asking for the day.
      const res = await eventLogsAPI.getMemorySearch({
        ...(date ? { date } : {}),
        ...(personId ? { person: personId } : {}),
        ...(itemId ? { item: itemId } : {}),
      });
      setEvents(res.data || []);
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, [date, personId, itemId]);

  // The option lists, once. Loaded from what the person has actually enrolled
  // rather than from the names appearing in the events: a belonging with no
  // sightings today should still be offerable, so that choosing it and seeing
  // nothing is an answer ("not seen today") rather than a missing control.
  useEffect(() => {
    (async () => {
      try {
        const [r, i] = await Promise.all([
          relationshipsAPI.getAll().catch(() => ({ data: [] })),
          userItemsAPI.getAll().catch(() => ({ data: [] })),
        ]);
        setPeople((r.data || []).filter(x => x?.person_name));
        setThings((i.data || []).filter(x => x?.item_name));
      } catch {
        // Filters are an addition to the page, never a condition of it.
      }
    })();
  }, []);

  // This page used to fetch on mount and when the date changed, and never
  // again. While a camera is running that makes it a snapshot of the moment it
  // was opened: a belonging put down two minutes ago was recorded, served
  // correctly by the API, and still absent from the page, because nothing had
  // asked for it. Anyone testing the system watches this page and concludes the
  // sighting was never logged.
  //
  // Only while looking at TODAY, and only while the tab is actually visible.
  // A past day cannot gain new memories, and a hidden tab polling every few
  // seconds is pure waste. Refreshing on becoming visible again covers the case
  // where the wearer walks back to the laptop after moving something.
  const isToday = !date || date === todayStr;
  useEffect(() => {
    if (!isToday) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') fetchEvents({ quiet: true });
    };
    const id = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [isToday, date]);

  const handleToggleFlag = async (eventId, currentFlag) => {
    if (!eventId) return;
    try {
      await eventLogsAPI.toggleFlag(eventId, !currentFlag);
      fetchEvents();
    } catch (e) {
      console.error(e);
      alert('Error toggling flag');
    }
  };

  const formattedEvents = events.map((ev) => {
    const dt = new Date(ev.timestamp);
    const now = new Date();
    let timeLabel = '-';
    let groupLabel = 'Earlier';

    if (dt) {
      timeLabel = formatClockTime(dt);
      
      const isToday = now.toDateString() === dt.toDateString();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const isYesterday = yesterday.toDateString() === dt.toDateString();
      
      if (date) {
        // Viewing one day: grouping everything under "Today" is a single wall
        // of cards. Split it into the parts of the day instead, so a whole
        // day's memories stay scannable.
        const h = dt.getHours();
        groupLabel = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
      } else if (isToday) {
        groupLabel = 'Today';
      } else if (isYesterday) {
        groupLabel = 'Yesterday';
      } else {
        groupLabel = dt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }

    if (ev.event_type === 'medication_intake' || ev.event_type === 'medication') {
      const conf = ev.confidence ? `${(ev.confidence * 100).toFixed(0)}%` : '';
      // A camera detection below the 0.85 auto-verify bar is logged as pending
      // rather than confirmed. It is a real detection and belongs on the
      // timeline, but must not claim to be verified.
      const pending = ev.verification_status === 'pending';
      return {
        id: ev._id,
        keyframe_id: ev.keyframe_id,
        title: `${pending ? 'Likely took' : 'Took'} ${ev.details?.medication_name || 'medication'}`,
        time: timeLabel,
        icon: Pill,
        color: pending ? 'var(--warning)' : 'var(--success)',
        group: groupLabel,
        category: 'Medicine',
        confidence: conf,
        status: pending ? '⏳ Needs confirmation' : '✓ Verified',
        hasImage: !!ev.keyframe_id,
        is_flagged: !!ev.is_flagged,
        image_url: ev.keyframe_id ? detectionAPI.getMedicationFrameImage(ev.keyframe_id) : null,
        thumb_url: null,   // medication frames have no thumbnail route yet
        location: ev.location
      };
    } else if (ev.event_type === 'social_interaction') {
      const personName = ev.person_id?.person_name || ev.details?.person || 'Unknown Person';
      return {
        id: ev._id,
        keyframe_id: ev.keyframe_id,
        person_id: ev.person_id?._id || ev.person_id,
        person_name: personName,
        title: `Saw ${personName}`,
        time: timeLabel,
        icon: User,
        color: 'var(--primary)',
        group: groupLabel,
        category: 'People',
        confidence: '',
        status: ev.verification_status === 'confirmed' ? '✓ Confirmed' : '',
        hasImage: !!ev.keyframe_id,
        is_flagged: !!ev.is_flagged,
        image_url: ev.keyframe_id ? detectionAPI.getKeyframeImage(ev.keyframe_id) : null,
        thumb_url: ev.keyframe_id ? detectionAPI.getKeyframeImage(ev.keyframe_id, 240) : null,
        location: ev.location
      };
    } else if (ev.event_type === 'activity') {
      return {
        id: ev._id,
        keyframe_id: ev.keyframe_id,
        // sentence, then label, then description: scene and activity sessions
        // all write sentence now, but records written before they did carry
        // only one of the others, and "Activity detected" says nothing.
        title: ev.details?.sentence || ev.details?.label || ev.details?.description || 'Activity detected',
        time: timeLabel,
        icon: Activity,
        color: 'var(--warning)',
        group: groupLabel,
        category: 'Activity',
        confidence: ev.confidence ? `${(ev.confidence * 100).toFixed(0)}%` : '',
        status: '',
        hasImage: !!ev.keyframe_id,
        is_flagged: !!ev.is_flagged,
        image_url: ev.keyframe_id ? detectionAPI.getKeyframeImage(ev.keyframe_id) : null,
        thumb_url: ev.keyframe_id ? detectionAPI.getKeyframeImage(ev.keyframe_id, 240) : null,
        location: ev.location
      };
    } else if (ev.event_type === 'object') {
      const itemsList = ev.details?.item_names || (ev.details?.items ? ev.details.items.map(it => it.name) : []);
      // A sighting. "Left" is a departure claim and belongs to the routine
      // monitor's left_behind alert, not to one frame of a resting object.
      const titleText = itemsList.length > 0
        ? `Spotted ${itemsList.slice(0, 3).join(', ')}${itemsList.length > 3 ? ` +${itemsList.length - 3} more` : ''}`
        : (ev.details?.summary || 'Items detected');
      // How sure we are this is THIS person's belonging, which is what the
      // entry claims. ev.confidence used to be YOLO's "is this a phone at all"
      // score, so a match that identified the wearer's own phone at 0.755 was
      // displayed as "32%". Older records keep the old number in ev.confidence,
      // so read the identity figure from details first, then fall back.
      const sims = (ev.details?.items || [])
        .map(it => it.exemplar_similarity)
        .filter(v => typeof v === 'number');
      const identity = ev.details?.identity_confidence
        ?? (sims.length ? Math.max(...sims) : ev.confidence);
      return {
        id: ev._id,
        keyframe_id: ev.keyframe_id,
        title: titleText,
        time: timeLabel,
        icon: Package,
        color: '#6366f1',
        group: groupLabel,
        category: 'Objects',
        confidence: identity ? `${(identity * 100).toFixed(0)}% match` : '',
        status: '✓ Logged',
        hasImage: !!ev.keyframe_id,
        is_flagged: !!ev.is_flagged,
        image_url: ev.keyframe_id ? detectionAPI.getKeyframeImage(ev.keyframe_id) : null,
        thumb_url: ev.keyframe_id ? detectionAPI.getKeyframeImage(ev.keyframe_id, 240) : null,
        location: ev.location,
        items: itemsList
      };
    }
    return null;
  }).filter(Boolean);

  const filteredMemories = activeFilter === 'All'
    ? formattedEvents
    : formattedEvents.filter(m => m.category === activeFilter);

  const searchedMemories = query.length > 0
    ? filteredMemories.filter(m => m.title.toLowerCase().includes(query.toLowerCase()))
    : filteredMemories;

  const groupedMemories = searchedMemories.reduce((acc, curr) => {
    if (!acc[curr.group]) acc[curr.group] = [];
    acc[curr.group].push(curr);
    return acc;
  }, {});

  const hasResults = Object.keys(groupedMemories).length > 0;

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="page-title">Memory Search</h2>
          <p className="page-description">
            {date
              ? `Everything recorded on ${new Date(`${date}T00:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`
              : 'Your most recent memories'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="btn"
            onClick={() => setDate(d => shiftDay(d || todayStr, -1))}
            title="Previous day"
            style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={date}
            max={todayStr}
            onChange={(e) => setDate(e.target.value)}
            className="form-input"
            style={{ padding: '6px 10px', fontSize: '0.9rem', height: 32, borderRadius: 8 }}
          />
          <button
            className="btn"
            onClick={() => setDate(d => shiftDay(d || todayStr, 1))}
            disabled={!date || date >= todayStr}
            title="Next day"
            style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                     opacity: (!date || date >= todayStr) ? 0.4 : 1 }}
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={() => setDate(date ? '' : todayStr)}
            className="btn"
            style={{ height: 32, padding: '0 12px', fontSize: '0.8rem', fontWeight: 600 }}
            title={date ? 'Show recent memories from any day' : 'Go back to a single day'}
          >
            {date ? 'All days' : 'By day'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={18} style={{ position: 'absolute', left: 14, top: 14, color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="form-input"
              style={{ paddingLeft: 42, height: 46 }}
              placeholder="Search, or ask where you left something..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') askAgent(query); }}
            />
          </div>
          {Speech && (
            <button
              onClick={listen}
              disabled={listening || asking}
              title={listening ? 'Listening' : 'Ask out loud'}
              className="btn btn-primary"
              style={{
                width: 46, height: 46, padding: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                background: listening ? 'var(--danger)' : undefined,
              }}
            >
              <Mic size={20} />
            </button>
          )}
        </div>

        {asking && (
          <div style={{ padding: '10px 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Looking through your memories...
          </div>
        )}

        {answer && !asking && (
          <div
            style={{
              display: 'flex', gap: 12, alignItems: 'flex-start',
              background: 'var(--border-light)', borderRadius: 10,
              padding: 12, marginBottom: 12,
            }}
          >
            {answer.keyframe_id && !answerImageBroken && (
              <img
                src={detectionAPI.getKeyframeImage(answer.keyframe_id, 240)}
                alt=""
                loading="lazy"
                onError={() => setAnswerImageBroken(true)}
                onClick={() => setLightbox({
                  url: detectionAPI.getKeyframeImage(answer.keyframe_id),
                  title: answer.answer,
                })}
                style={{
                  width: 84, height: 84, borderRadius: 8, objectFit: 'cover',
                  cursor: 'zoom-in', flexShrink: 0,
                }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.45 }}>
                {answer.answer}
              </div>
              {/* The place is deliberately absent: nothing in the record says
                  which room it was, so the photograph is the answer to "where". */}
              {answer.keyframe_id && !answerImageBroken && (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
                  Tap the photo to see the spot.
                </div>
              )}
            </div>
            <button
              onClick={() => setAnswer(null)}
              title="Dismiss"
              className="btn"
              style={{ width: 28, height: 28, padding: 0, flexShrink: 0 }}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Narrowing by who or by what (FE 6-3). Choosing one clears the other:
            a face event has no belonging and an object event has no person, so
            both at once can only ever return nothing. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <select
            value={personId}
            onChange={(e) => { setPersonId(e.target.value); if (e.target.value) setItemId(''); }}
            className="form-input"
            style={{ padding: '6px 10px', fontSize: '0.85rem', height: 32, borderRadius: 8, maxWidth: 200 }}
            title="Show only interactions with one person"
          >
            <option value="">Anyone</option>
            {people.map(pp => (
              <option key={pp._id} value={pp._id}>{pp.person_name}</option>
            ))}
          </select>
          <select
            value={itemId}
            onChange={(e) => { setItemId(e.target.value); if (e.target.value) setPersonId(''); }}
            className="form-input"
            style={{ padding: '6px 10px', fontSize: '0.85rem', height: 32, borderRadius: 8, maxWidth: 200 }}
            title="Show only sightings of one belonging"
          >
            <option value="">Any belonging</option>
            {things.map(t => (
              <option key={t._id} value={t._id}>{t.item_name}</option>
            ))}
          </select>
          {(personId || itemId) && (
            <button
              onClick={() => { setPersonId(''); setItemId(''); }}
              className="btn"
              style={{ height: 32, padding: '0 12px', fontSize: '0.8rem', fontWeight: 600 }}
            >
              Clear
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              style={{
                padding: '6px 14px', borderRadius: 20, fontSize: '0.85rem', fontWeight: 600,
                whiteSpace: 'nowrap', transition: 'all 0.2s', border: 'none', cursor: 'pointer',
                background: activeFilter === f
                  ? (f === 'Medicine' ? 'var(--success)' : f === 'Activity' ? 'var(--warning)' : 'var(--primary)')
                  : 'var(--border-light)',
                color: activeFilter === f ? '#fff' : 'var(--text-secondary)'
              }}
            >
              {f === 'All' ? `All (${formattedEvents.length})` : `${f} (${formattedEvents.filter(m => m.category === f).length})`}
            </button>
          ))}
        </div>
      </div>

      {!hasResults && !loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          <SearchX size={56} style={{ opacity: 0.5, marginBottom: 12 }} />
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {query.length > 0 ? 'No results found' : 'No memories yet'}
          </div>
          <div style={{ fontSize: '0.85rem', textAlign: 'center' }}>
            When the AI camera detects events, they will appear here.
          </div>
        </div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {Object.entries(groupedMemories).map(([group, items]) => (
            <div key={group}>
              <h3 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                {group}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.map(m => {
                  const Icon = m.icon;
                  return (
                    <div key={m.id} className="card" style={{
                      padding: 0, overflow: 'hidden',
                      borderLeft: `4px solid ${m.color}`,
                      border: m.is_flagged ? `2px solid var(--primary)` : undefined,
                      boxShadow: m.is_flagged ? '0 0 0 2px var(--primary-light)' : 'none',
                      position: 'relative'
                    }}>
                      <button 
                        onClick={(e) => { e.stopPropagation(); handleToggleFlag(m.id, m.is_flagged); }}
                        style={{ 
                          position: 'absolute', top: 12, right: 12, zIndex: 10,
                          background: 'rgba(0,0,0,0.05)', border: 'none', cursor: 'pointer', 
                          color: m.is_flagged ? 'var(--primary)' : 'var(--text-muted)', padding: 6, borderRadius: '50%'
                        }}
                        title={m.is_flagged ? "Unflag Event" : "Flag Event"}
                      >
                        <Pin size={16} fill={m.is_flagged ? 'currentColor' : 'none'} />
                      </button>
                      {m.hasImage && m.image_url && !brokenImages.has(m.id) ? (
                        <div style={{ display: 'flex' }}>
                          <div
                            className="memory-thumb"
                            onClick={() => setLightbox({ url: m.image_url, title: m.title })}
                            title="Click to view full image"
                            style={{
                              width: 100, minHeight: 80, flexShrink: 0,
                              overflow: 'hidden', position: 'relative', cursor: 'zoom-in',
                            }}
                          >
                            <img
                              // The thumbnail, not the capture. Drawn 100px wide,
                              // so 240 covers a 2x display and still costs a
                              // fraction of the full frame. The lightbox above
                              // opens m.image_url, which is the full one.
                              src={m.thumb_url || m.image_url}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              // The frame has aged out. Fall back to the layout
                              // used by memories that never had one, so every
                              // card lines up the same way.
                              onError={() => markImageBroken(m.id)}
                            />
                          </div>
                          <div style={{ padding: 14, flex: 1, display: 'flex', alignItems: 'center', gap: 14 }}>
                            <div style={{
                              width: 40, height: 40, borderRadius: 10, background: `${m.color}20`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                              <Icon size={18} style={{ color: m.color }} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                                {m.person_id ? (
                                  <>
                                    Saw <Link to={`/interactions/${m.person_id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }} className="hover:underline">{m.person_name}</Link>
                                  </>
                                ) : (
                                  m.title
                                )}
                              </div>
                              <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{m.time}</span>
                                {m.confidence && (
                                  <span style={{
                                    fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary)',
                                    background: 'var(--primary-light)', padding: '2px 8px', borderRadius: 12,
                                  }}>{m.confidence}</span>
                                )}
                                {m.status && (
                                  <span style={{
                                    fontSize: '0.7rem', fontWeight: 700,
                                    color: 'var(--success)',
                                    background: 'rgba(34,197,94,0.15)',
                                    padding: '2px 8px', borderRadius: 12,
                                  }}>{m.status}</span>
                                )}
                                {m.location && (
                                  <a 
                                    href={`https://www.google.com/maps/search/?api=1&query=${m.location.lat},${m.location.lng}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={`Lat: ${m.location.lat}, Lng: ${m.location.lng}`}
                                    style={{
                                      fontSize: '0.7rem', fontWeight: 700,
                                      color: '#4F46E5',
                                      background: 'rgba(79, 70, 229, 0.15)',
                                      padding: '2px 8px', borderRadius: 12,
                                      display: 'flex', alignItems: 'center', gap: 4,
                                      cursor: 'pointer',
                                      textDecoration: 'none'
                                    }}
                                  >
                                    <MapPin size={10} />
                                    Location Logged
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
                          <div style={{
                            width: 44, height: 44, borderRadius: 12, background: `${m.color}20`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}>
                            <Icon size={20} style={{ color: m.color }} />
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                              {m.person_id ? (
                                <>
                                  Saw <Link to={`/interactions/${m.person_id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }} className="hover:underline">{m.person_name}</Link>
                                </>
                              ) : (
                                m.title
                              )}
                            </div>
                            <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{m.time}</span>
                              {m.confidence && (
                                <span style={{
                                  fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary)',
                                  background: 'var(--primary-light)', padding: '2px 8px', borderRadius: 12,
                                }}>{m.confidence}</span>
                              )}
                              {m.status && (
                                <span style={{
                                  fontSize: '0.7rem', fontWeight: 700,
                                  color: 'var(--success)',
                                  background: 'rgba(34,197,94,0.15)',
                                  padding: '2px 8px', borderRadius: 12,
                                }}>{m.status}</span>
                              )}
                              {m.location && (
                                <a 
                                  href={`https://www.google.com/maps/search/?api=1&query=${m.location.lat},${m.location.lng}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`Lat: ${m.location.lat}, Lng: ${m.location.lng}`}
                                  style={{
                                    fontSize: '0.7rem', fontWeight: 700,
                                    color: '#4F46E5',
                                    background: 'rgba(79, 70, 229, 0.15)',
                                    padding: '2px 8px', borderRadius: 12,
                                    display: 'flex', alignItems: 'center', gap: 4,
                                    cursor: 'pointer',
                                    textDecoration: 'none'
                                  }}
                                >
                                  <MapPin size={10} />
                                  Location Logged
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '92vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <span style={{ color: '#fff', fontWeight: 600, fontSize: '0.95rem' }}>{lightbox.title}</span>
              <button
                onClick={() => setLightbox(null)}
                aria-label="Close"
                style={{
                  background: 'transparent', border: 'none', color: '#fff',
                  cursor: 'pointer', display: 'flex', padding: 4,
                }}
              >
                <X size={22} />
              </button>
            </div>
            <img
              src={lightbox.url}
              alt={lightbox.title}
              style={{
                maxWidth: '92vw', maxHeight: '82vh',
                objectFit: 'contain', borderRadius: 10, background: '#000',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

