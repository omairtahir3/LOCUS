import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { relationshipsAPI, detectionAPI } from '../services/api';
import { ChevronLeft, User, Calendar } from 'lucide-react';
import { formatSmartDate } from '../utils/dateUtils';

export default function PastInteractions() {
  const { id } = useParams();
  const [relationship, setRelationship] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await relationshipsAPI.getInteractions(id);
        setRelationship(res.data.relationship);
        setInteractions(res.data.interactions || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading) {
    return <div className="p-4 text-gray-500">Loading interactions...</div>;
  }

  if (!relationship) {
    return <div className="p-4 text-red-500">Person not found.</div>;
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      <div className="page-header">
        <div>
          <Link to={-1} style={{ display: 'flex', alignItems: 'center', color: 'var(--accent)', textDecoration: 'none', marginBottom: 8 }}>
            <ChevronLeft size={16} style={{ marginRight: 4 }} />
            Back
          </Link>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%', background: 'var(--accent)', color: '#fff', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem', fontWeight: 'bold'
            }}>
              {relationship.person_name.charAt(0).toUpperCase()}
            </div>
            {relationship.person_name}
          </h1>
          <p className="page-subtitle" style={{ marginTop: 4 }}>
            {relationship.relationship_type ? `Relation: ${relationship.relationship_type}` : 'Social Interaction History'}
          </p>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Calendar size={20} color="var(--accent)" />
          Interaction Timeline
        </h2>
        
        {interactions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-secondary)', background: 'var(--bg)', borderRadius: 8, border: '1px dashed var(--border-light)' }}>
            <User size={32} style={{ margin: '0 auto 12px auto', opacity: 0.5 }} />
            <p>No past interactions found.</p>
            <p style={{ fontSize: '0.875rem' }}>When the AI spots {relationship.person_name} again, it will appear here.</p>
          </div>
        ) : (
          <div style={{ position: 'relative', borderLeft: '2px solid rgba(99, 102, 241, 0.2)', marginLeft: 12, paddingBottom: 16 }}>
            {interactions.map((interaction, i) => (
              <div key={interaction._id} style={{ position: 'relative', paddingLeft: 24, marginBottom: 32 }}>
                <div style={{ position: 'absolute', left: -9, top: 4, width: 16, height: 16, borderRadius: '50%', background: '#fff', border: '2px solid var(--accent)', zIndex: 10 }} />
                
                <div style={{ background: 'var(--bg)', padding: 16, borderRadius: 8, border: '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>Social Interaction</span>
                      <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                        {formatSmartDate(interaction.timestamp)}
                      </p>
                    </div>
                  </div>
                  
                  {interaction.keyframe_id && (
                    <div className="interaction-thumb" style={{ marginTop: 12, overflow: 'hidden', borderRadius: 6, border: '1px solid var(--border-light)', maxWidth: 400 }}>
                      <img 
                        src={detectionAPI.getKeyframeImage(interaction.keyframe_id)} 
                        alt="Interaction"
                        style={{ width: '100%', height: 192, objectFit: 'cover' }}
                        onError={(e) => {
                          e.target.onerror = null;
                          const container = e.target.closest('.interaction-thumb');
                          if (container) container.style.display = 'none';
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
