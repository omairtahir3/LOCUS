import { useState } from 'react';
import { Search, Shield, Mic, SearchX, Footprints, User, Pill, Hospital, ShoppingCart, Video } from 'lucide-react';

const FILTERS = ['All', 'People', 'Places', 'Objects', 'Events'];

const RECENT_MEMORIES = [
  { id: 1, title: 'Morning walk in the park', time: '2 hours ago', icon: Footprints, color: 'var(--info)', group: 'Today' },
  { id: 2, title: 'Met Sarah at the cafe', time: '4 hours ago', icon: User, color: 'var(--accent)', group: 'Today' },
  { id: 3, title: 'Took morning medication', time: '6 hours ago', icon: Pill, color: 'var(--success)', group: 'Today' },
  { id: 4, title: 'Doctor appointment', time: 'Yesterday', icon: Hospital, color: 'var(--danger)', group: 'Yesterday' },
  { id: 5, title: 'Grocery shopping', time: 'Yesterday', icon: ShoppingCart, color: 'var(--warning)', group: 'Yesterday' },
  { id: 6, title: 'Video call with family', time: '2 days ago', icon: Video, color: 'var(--primary)', group: '2 Days Ago' },
];

export default function MemorySearch() {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');

  // Group memories
  const groupedMemories = RECENT_MEMORIES.reduce((acc, curr) => {
    if (!acc[curr.group]) acc[curr.group] = [];
    acc[curr.group].push(curr);
    return acc;
  }, {});

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title">Memory Search</h2>
          <p className="page-description">Search your memories using AI</p>
        </div>
        <div style={{
          background: 'linear-gradient(135deg, var(--accent), var(--primary))',
          padding: '4px 10px', borderRadius: 20, color: '#fff', fontSize: '10px', fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: 4
        }}>
          <Shield size={10} color="#fff" /> Coming Soon
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
                background: activeFilter === f ? 'var(--primary)' : 'var(--border-light)',
                color: activeFilter === f ? '#fff' : 'var(--text-secondary)'
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {query.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          <SearchX size={56} style={{ opacity: 0.5, marginBottom: 12 }} />
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>Search coming soon</div>
          <div style={{ fontSize: '0.85rem', textAlign: 'center' }}>Multi-modal memory search will be<br />available with the AI backend</div>
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
                    <div key={m.id} className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
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
