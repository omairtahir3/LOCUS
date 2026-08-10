import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Search, Shield, Mic, SearchX, Footprints, User, Pill, Hospital, ShoppingCart, Video, Camera, Pin } from 'lucide-react';
import { eventLogsAPI, detectionAPI } from '../services/api';

const FILTERS = ['All', 'Medicine', 'People'];

export default function MemorySearch() {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const res = await eventLogsAPI.getMemorySearch({ limit: 50 });
      setEvents(res.data || []);
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, []);

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

  const formattedEvents = events.map((ev, i) => {
    const dt = new Date(ev.timestamp);
    const now = new Date();
    let timeLabel = '-';
    let groupLabel = 'Earlier';

    if (dt) {
      const diffMs = now - dt;
      const diffHrs = diffMs / (1000 * 60 * 60);
      const diffDays = Math.floor(diffHrs / 24);

      if (diffDays === 0) {
        if (diffHrs < 1) {
          const diffMins = Math.floor(diffMs / (1000 * 60));
          timeLabel = diffMins <= 1 ? 'Just now' : `${diffMins} mins ago`;
        } else {
          timeLabel = `${Math.floor(diffHrs)} hours ago`;
        }
        groupLabel = 'Today';
      } else if (diffDays === 1) {
        timeLabel = 'Yesterday';
        groupLabel = 'Yesterday';
      } else {
        timeLabel = `${diffDays} days ago`;
        groupLabel = `${diffDays} Days Ago`;
      }
    }

    if (ev.event_type === 'medication_intake' || ev.event_type === 'medication') {
      const conf = ev.confidence ? `${(ev.confidence * 100).toFixed(0)}%` : '';
      return {
        id: ev._id,
        keyframe_id: ev.keyframe_id,
        title: `Took ${ev.details?.medication_name || 'medication'}`,
        time: timeLabel,
        icon: Pill,
        color: 'var(--success)',
        group: groupLabel,
        category: 'Medicine',
        confidence: conf,
        status: '✓ Verified',
        hasImage: !!ev.keyframe_id,
        is_flagged: !!ev.is_flagged,
        image_url: ev.keyframe_id ? detectionAPI.getMedicationFrameImage(ev.keyframe_id) : null
      };
    } else if (ev.event_type === 'social_interaction') {
      const personName = ev.person_id?.person_name || ev.details?.person || 'Unknown Person';
      return {
        id: ev._id,
        keyframe_id: ev.keyframe_id,
        person_id: ev.person_id?._id || ev.person_id,
        person_name: personName,
        title: `Saw `,
        time: timeLabel,
        icon: User,
        color: 'var(--primary)',
        group: groupLabel,
        category: 'People',
        confidence: '',
        status: ev.verification_status === 'confirmed' ? '✓ Confirmed' : '',
        hasImage: !!ev.keyframe_id,
        is_flagged: !!ev.is_flagged,
        image_url: ev.keyframe_id ? detectionAPI.getKeyframeImage(ev.keyframe_id) : null
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
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title">Memory Search</h2>
          <p className="page-description">Search your memories using AI</p>
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
              placeholder="Search your memories..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" style={{ width: 46, height: 46, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Mic size={20} />
          </button>
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
                  ? (f === 'Medicine' ? 'var(--success)' : 'var(--primary)')
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
                      {m.hasImage && m.image_url ? (
                        <div style={{ display: 'flex' }}>
                          <div style={{
                            width: 100, minHeight: 80, flexShrink: 0,
                            background: '#111', position: 'relative',
                          }}>
                            <img
                              src={m.image_url}
                              alt=""
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              onError={(e) => { e.target.style.display = 'none'; }}
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
                            <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{m.title}</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 2 }}>{m.time}</div>
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
    </div>
  );
}
