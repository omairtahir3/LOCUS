import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { caregiverAPI } from '../services/api';
import { Users, ChevronRight, Search } from 'lucide-react';
import PageHeader from '../components/Layout/PageHeader';
import Loading from '../components/Feedback/Loading';
import { adherencePct, NO_DATA, NO_DATA_LABEL } from '../utils/adherence';

const AVATAR_COLORS = ['#0D9488', '#6366F1', '#EC4899', '#F59E0B', '#10B981', '#3B82F6'];

export default function FamilyMembers() {
  const [users, setUsers] = useState([]);
  const [summaries, setSummaries] = useState({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await caregiverAPI.getUsers();
        const list = res.data || [];
        setUsers(list);
        const sums = {};
        await Promise.all(list.map(async (u) => {
          try {
            const r = await caregiverAPI.getUserSummary(u._id);
            sums[u._id] = r.data;
          } catch { sums[u._id] = null; }
        }));
        setSummaries(sums);
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  const filtered = users.filter(u =>
    u.name?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <PageHeader
        title="Family Members"
        description="Family you're monitoring"
        actions={
          <div style={{ position: 'relative' }}>
            <input
              className="form-input"
              placeholder="Search family members..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 36, width: 260 }}
            />
            <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          </div>
        }
      />

      {loading ? (
        <Loading rows={4} label="Loading family members" />
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <Users size={48} />
            <h3>{search ? 'No matching family members' : 'No family members linked'}</h3>
            <p>Ask your family members to link you as their caregiver from the LOCUS mobile app.</p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {filtered.map((u, i) => {
            const s = summaries[u._id];
            const adh = s?.today_adherence;
            return (
              <Link key={u._id} to={`/family/${u._id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="card" style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    {(u.picture || u.profile_picture) ? (
                      <img 
                        src={u.picture || u.profile_picture} 
                        alt="" 
                        className="avatar avatar-lg" 
                        referrerPolicy="no-referrer"
                        crossOrigin="anonymous"
                        style={{ objectFit: 'cover', borderRadius: '50%', border: '2px solid var(--primary)' }} 
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    ) : (
                      <div className="avatar avatar-lg" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                        {u.name?.charAt(0)?.toUpperCase()}
                      </div>
                    )}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '1rem' }}>{u.name}</div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </div>
                    <ChevronRight size={18} style={{ color: 'var(--text-muted)' }} />
                  </div>
                  {adh && (
                    <div style={{ display: 'flex', gap: 12, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-light)' }}>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div className="font-bold" style={{ color: 'var(--success-text)' }}>{adh.taken || 0}</div>
                        <div className="text-xs text-muted">Taken</div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div className="font-bold" style={{ color: 'var(--danger-text)' }}>{adh.missed || 0}</div>
                        <div className="text-xs text-muted">Missed</div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div className="font-bold" style={{ color: 'var(--primary-text)' }}>
                          {adherencePct(adh) === null
                            ? <span style={{ color: 'var(--text-muted)' }} title={NO_DATA_LABEL}>{NO_DATA}</span>
                            : `${adherencePct(adh)}%`}
                        </div>
                        <div className="text-xs text-muted">Adherence</div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div className="font-bold" style={{ color: 'var(--warning-text)' }}>{s?.pending_alerts?.length || 0}</div>
                        <div className="text-xs text-muted">Alerts</div>
                      </div>
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
