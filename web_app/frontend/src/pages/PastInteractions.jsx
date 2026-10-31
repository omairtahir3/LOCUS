import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { relationshipsAPI, detectionAPI } from '../services/api';
import { ChevronLeft, User, Calendar, MapPin } from 'lucide-react';
import { formatSmartDate } from '../utils/dateUtils';
import PageHeader from '../components/Layout/PageHeader';

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
      <Link to={-1} className="page-back">
        <ChevronLeft size={16} />
        Back
      </Link>

      <PageHeader
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="avatar" style={{ width: 44, height: 44, background: 'var(--accent)' }}>
              {relationship.person_name.charAt(0).toUpperCase()}
            </span>
            {relationship.person_name}
          </span>
        }
        description={relationship.relationship_type
          ? `Relation: ${relationship.relationship_type}`
          : 'Social interaction history'}
      />

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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: 0 }}>
                          {formatSmartDate(interaction.timestamp)}
                        </p>
                        {interaction.location && (
                          <a 
                            href={`https://www.google.com/maps/search/?api=1&query=${interaction.location.lat},${interaction.location.lng}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Lat: ${interaction.location.lat}, Lng: ${interaction.location.lng}`}
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
                  
                  {interaction.keyframe_id && (
                    <div className="interaction-thumb" style={{ marginTop: 12, overflow: 'hidden', borderRadius: 6, border: '1px solid var(--border-light)', maxWidth: 400, backgroundColor: '#000' }}>
                      <img 
                        src={detectionAPI.getKeyframeImage(interaction.keyframe_id)} 
                        alt="Interaction"
                        style={{ width: '100%', height: 192, objectFit: 'contain' }}
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
