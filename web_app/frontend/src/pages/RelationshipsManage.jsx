import { useState, useEffect } from 'react';
import { relationshipsAPI } from '../services/api';
import { Users, Merge, Trash2, AlertTriangle, Search } from 'lucide-react';

export default function RelationshipsManage() {
  const [relationships, setRelationships] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  
  // Merge state
  const [isMerging, setIsMerging] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [mergeLoading, setMergeLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchRelationships = async () => {
    try {
      const res = await relationshipsAPI.getAll();
      setRelationships(res.data || []);
    } catch (err) {
      console.error(err);
      setError('Failed to load relationships.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRelationships();
  }, []);

  const handleMerge = async () => {
    if (!sourceId || !targetId || sourceId === targetId) {
      setError('Please select two distinct relationships to merge.');
      return;
    }
    
    setMergeLoading(true);
    setError('');
    
    try {
      await relationshipsAPI.merge({ sourceId, targetId });
      setIsMerging(false);
      setSourceId('');
      setTargetId('');
      await fetchRelationships();
    } catch (err) {
      console.error(err);
      setError('Merge failed. Please try again.');
    } finally {
      setMergeLoading(false);
    }
  };

  const filtered = relationships.filter(r => 
    r.person_name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading relationships...</div>;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: 'none' }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Users color="var(--accent)" />
            Manage Relationships
          </h1>
          <p className="page-subtitle" style={{ marginTop: 4 }}>
            Merge duplicates or review confirmed faces.
          </p>
        </div>
        <button 
          onClick={() => setIsMerging(!isMerging)}
          className={`btn ${isMerging ? 'btn-secondary' : 'btn-primary'}`}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <Merge size={18} />
          {isMerging ? 'Cancel Merge' : 'Merge Duplicates'}
        </button>
      </div>

      {error && (
        <div style={{ background: 'var(--danger-light)', color: '#991B1B', padding: 16, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #FCA5A5' }}>
          <AlertTriangle size={20} />
          {error}
        </div>
      )}

      {isMerging && (
        <div style={{ background: '#EFF6FF', border: '1px solid #DBEAFE', padding: 24, borderRadius: 12 }}>
          <h3 style={{ fontWeight: 600, color: '#1E3A8A', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Merge size={18} />
            Merge Two Records
          </h3>
          <p style={{ fontSize: '0.875rem', color: '#1D4ED8', marginBottom: 16 }}>
            Select a source record to delete, and a target record to keep. The source's interaction history and face embeddings will be permanently moved into the target record.
          </p>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>Source (Will be deleted)</label>
              <select 
                className="form-input"
                style={{ width: '100%' }}
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
              >
                <option value="">Select a relationship...</option>
                {relationships.map(r => (
                  <option key={r._id} value={r._id} disabled={r._id === targetId}>
                    {r.person_name} ({new Date(r.createdAt).toLocaleDateString()}) - {r._id.substring(18)}
                  </option>
                ))}
              </select>
            </div>
            
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>Target (Will be kept)</label>
              <select 
                className="form-input"
                style={{ width: '100%' }}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">Select a relationship...</option>
                {relationships.map(r => (
                  <option key={r._id} value={r._id} disabled={r._id === sourceId}>
                    {r.person_name} ({new Date(r.createdAt).toLocaleDateString()}) - {r._id.substring(18)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          
          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
            <button 
              onClick={handleMerge}
              disabled={mergeLoading || !sourceId || !targetId}
              className="btn btn-primary"
              style={{ background: '#2563EB', borderColor: '#2563EB', opacity: (!sourceId || !targetId || mergeLoading) ? 0.5 : 1 }}
            >
              {mergeLoading ? 'Merging...' : 'Confirm Merge'}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Search size={18} color="var(--text-muted)" />
          <input 
            type="text" 
            placeholder="Search names..." 
            className="form-input"
            style={{ border: 'none', boxShadow: 'none', padding: 0, width: '100%', background: 'transparent' }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        
        <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg)', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              <th style={{ padding: 16, fontWeight: 500 }}>Name</th>
              <th style={{ padding: 16, fontWeight: 500 }}>Relation</th>
              <th style={{ padding: 16, fontWeight: 500 }}>Confirmed By</th>
              <th style={{ padding: 16, fontWeight: 500 }}>Added</th>
              <th style={{ padding: 16, fontWeight: 500, textAlign: 'right' }}>ID</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan="5" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                  No relationships found.
                </td>
              </tr>
            ) : filtered.map((r, idx) => (
              <tr key={r._id} style={{ borderTop: idx > 0 ? '1px solid var(--border-light)' : 'none' }}>
                <td style={{ padding: 16, fontWeight: 500, color: 'var(--text-primary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(99, 102, 241, 0.1)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '0.75rem' }}>
                      {r.person_name.charAt(0).toUpperCase()}
                    </div>
                    {r.person_name}
                  </div>
                </td>
                <td style={{ padding: 16, color: 'var(--text-secondary)' }}>{r.relationship_type || '-'}</td>
                <td style={{ padding: 16 }}>
                  <span style={{ background: 'var(--bg)', color: 'var(--text-primary)', padding: '4px 8px', borderRadius: 4, fontSize: '0.75rem' }}>
                    {r.confirmed_by}
                  </span>
                </td>
                <td style={{ padding: 16, color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  {new Date(r.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: 16, color: 'var(--text-muted)', fontSize: '0.75rem', textAlign: 'right', fontFamily: 'monospace' }}>
                  ...{r._id.substring(18)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
