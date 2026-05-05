import { useState, useEffect } from 'react';
import { Search, Shield, Mic, SearchX, Footprints, User, Pill, Hospital, ShoppingCart, Video, Camera } from 'lucide-react';
import { detectionAPI } from '../services/api';

const FILTERS = ['All', 'People', 'Places', 'Objects', 'Events', 'Medicine'];

const RECENT_MEMORIES = [
  { id: 1, title: 'Morning walk in the park', time: '2 hours ago', icon: Footprints, color: 'var(--info)', group: 'Today', category: 'Events' },
  { id: 2, title: 'Met Sarah at the cafe', time: '4 hours ago', icon: User, color: 'var(--accent)', group: 'Today', category: 'People' },
  { id: 4, title: 'Doctor appointment', time: 'Yesterday', icon: Hospital, color: 'var(--danger)', group: 'Yesterday', category: 'Events' },
  { id: 5, title: 'Grocery shopping', time: 'Yesterday', icon: ShoppingCart, color: 'var(--warning)', group: 'Yesterday', category: 'Events' },
  { id: 6, title: 'Video call with family', time: '2 days ago', icon: Video, color: 'var(--primary)', group: '2 Days Ago', category: 'People' },
];

export default function MemorySearch() {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const [medKeyframes, setMedKeyframes] = useState([]);
  const [loadingMeds, setLoadingMeds] = useState(false);

  // Load medication keyframes on mount
  useEffect(() => {
    const fetchMedKeyframes = async () => {
      setLoadingMeds(true);
      try {
        const res = await detectionAPI.getKeyframes({ medication_only: true, limit: 30 });
        setMedKeyframes(res.data || []);
      } catch (e) {
        console.error('Failed to load medication keyframes:', e);
      } finally {
        setLoadingMeds(false);
      }
    };
    fetchMedKeyframes();
  }, []);

  // Build medicine memory items from real keyframe data (only medicine_taken frames)
  const takenKeyframes = medKeyframes.filter(kf => kf.medicine_taken);
  const medMemories = takenKeyframes.map((kf, i) => {
    const dt = kf.detected_at ? new Date(kf.detected_at) : kf.saved_at ? new Date(kf.saved_at) : null;
    const now = new Date();
    let timeLabel = '-';
    let groupLabel = 'Earlier';

    if (dt) {
      const diffMs = now - dt;
      const diffHrs = diffMs / (1000 * 60 * 60);
      const diffDays = Math.floor(diffHrs / 24);

      if (diffDays === 0) {
        timeLabel = diffHrs < 1 ? 'Just now' : `${Math.floor(diffHrs)} hours ago`;
        groupLabel = 'Today';
      } else if (diffDays === 1) {
        timeLabel = 'Yesterday';
        groupLabel = 'Yesterday';
      } else {
        timeLabel = `${diffDays} days ago`;
        groupLabel = `${diffDays} Days Ago`;
      }
    }

    const conf = kf.detection_confidence ? `${(kf.detection_confidence * 100).toFixed(0)}%` : '';
    const statusLabel = kf.detection_status === 'taken' ? '✓ Verified' : '⏳ Pending';

    // Phase role labels
    const phaseLabels = {
      phase1_pill_visible: 'Pill Visible',
      phase2_grip_motion: 'Grip & Motion',
      phase3_pill_gone: 'Pill Gone',
    };
    const phaseLabel = phaseLabels[kf.phase_role] || '';

    return {
      id: `med-${kf.keyframe_id || i}`,
      keyframe_id: kf.keyframe_id,
      title: `Took ${kf.medication_name || 'medication'}`,
      time: timeLabel,
      icon: Pill,
      color: kf.detection_status === 'taken' ? 'var(--success)' : 'var(--warning)',
      group: groupLabel,
      category: 'Medicine',
      confidence: conf,
      status: statusLabel,
      detection_status: kf.detection_status,
      phase_role: kf.phase_role,
      phase_label: phaseLabel,
      hasImage: true,
    };
  });

  // Merge real medicine data with static placeholder memories
  const allMemories = [...RECENT_MEMORIES, ...medMemories];

  // Apply filter
  const filteredMemories = activeFilter === 'All'
    ? allMemories
    : allMemories.filter(m => m.category === activeFilter);

  // Apply search
  const searchedMemories = query.length > 0
    ? filteredMemories.filter(m => m.title.toLowerCase().includes(query.toLowerCase()))
    : filteredMemories;

  // Group by time
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
              {f === 'Medicine' ? `${f} (${takenKeyframes.length})` : f}
            </button>
          ))}
        </div>
      </div>

      {!hasResults ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          <SearchX size={56} style={{ opacity: 0.5, marginBottom: 12 }} />
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {query.length > 0 ? 'No results found' : 'No memories yet'}
          </div>
          <div style={{ fontSize: '0.85rem', textAlign: 'center' }}>
            {activeFilter === 'Medicine'
              ? 'When the AI camera detects you taking medicine, snapshots will appear here.'
              : 'Try searching for a memory or selecting a different category.'}
          </div>
        </div>
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
                      borderLeft: m.category === 'Medicine' ? `4px solid ${m.color}` : 'none',
                    }}>
                      {/* Medicine items with image */}
                      {m.hasImage && m.keyframe_id ? (
                        <div style={{ display: 'flex' }}>
                          <div style={{
                            width: 100, minHeight: 80, flexShrink: 0,
                            background: '#111', position: 'relative',
                          }}>
                            <img
                              src={detectionAPI.getKeyframeImage(m.keyframe_id)}
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
                              <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{m.title}</div>
                              <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{m.time}</span>
                                {m.phase_label && (
                                  <span style={{
                                    fontSize: '0.65rem', fontWeight: 700, color: '#6366f1',
                                    background: 'rgba(99,102,241,0.12)', padding: '2px 8px', borderRadius: 12,
                                  }}>{m.phase_label}</span>
                                )}
                                {m.confidence && (
                                  <span style={{
                                    fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary)',
                                    background: 'var(--primary-light)', padding: '2px 8px', borderRadius: 12,
                                  }}>{m.confidence}</span>
                                )}
                                <span style={{
                                  fontSize: '0.7rem', fontWeight: 700,
                                  color: m.detection_status === 'taken' ? 'var(--success)' : 'var(--warning)',
                                  background: m.detection_status === 'taken' ? 'rgba(34,197,94,0.15)' : 'rgba(234,179,8,0.15)',
                                  padding: '2px 8px', borderRadius: 12,
                                }}>{m.status}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* Regular memory items */
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
