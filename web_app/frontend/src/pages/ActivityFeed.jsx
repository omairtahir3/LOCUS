import { Activity, Brain, Moon, Footprints, Shield, Coffee, Clock, TrendingUp } from 'lucide-react';

// Mock data for the activity feed
const mockActivities = [
  { time: '08:15 AM', type: 'routine', title: 'Morning routine started', detail: 'Woke up and left bedroom', icon: Coffee },
  { time: '08:30 AM', type: 'medication', title: 'Medication taken', detail: 'Morning dose confirmed by camera', icon: Activity },
  { time: '09:00 AM', type: 'social', title: 'Social interaction', detail: 'Met with neighbor Mrs. Johnson', icon: Brain },
  { time: '10:30 AM', type: 'movement', title: 'Walk detected', detail: '~2,400 steps in the garden', icon: Footprints },
  { time: '12:00 PM', type: 'routine', title: 'Lunch preparation', detail: 'Kitchen activity for 25 minutes', icon: Coffee },
  { time: '02:00 PM', type: 'rest', title: 'Afternoon rest', detail: 'Resting period - 1.5 hours', icon: Moon },
  { time: '04:00 PM', type: 'anomaly', title: '⚠ Anomaly detected', detail: 'Unusual inactivity period', icon: Activity },
];

const typeColors = {
  routine: 'var(--primary)',
  medication: 'var(--success)',
  social: 'var(--accent)',
  movement: 'var(--info)',
  rest: 'var(--text-muted)',
  anomaly: 'var(--warning)',
};

export default function ActivityFeed() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Activity Feed</h2>
          <p className="page-description">Behavioral monitoring and routine analysis</p>
        </div>
        <span className="coming-soon-badge"><Shield size={12} /> Coming Soon</span>
      </div>

      <div className="grid-2">
        {/* Timeline */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Today's Activity Timeline</div>
              <div className="card-subtitle">Sample data — Module 1 backend required</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {mockActivities.map((act, i) => {
              const Icon = act.icon;
              return (
                <div key={i} style={{ display: 'flex', gap: 14, padding: '12px 0', position: 'relative' }}>
                  {/* Timeline line */}
                  {i < mockActivities.length - 1 && (
                    <div style={{
                      position: 'absolute', left: 17, top: 44, bottom: -12,
                      width: 2, background: 'var(--border)', zIndex: 0,
                    }} />
                  )}
                  {/* Dot */}
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: typeColors[act.type] + '20',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0, zIndex: 1,
                  }}>
                    <Icon size={16} style={{ color: typeColors[act.type] }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{act.title}</span>
                      <span className="text-xs text-muted">{act.time}</span>
                    </div>
                    <div className="text-sm text-muted">{act.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Insights */}
        <div>
          <div className="stat-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-icon primary"><Footprints size={18} /></div>
              <div>
                <div className="stat-value">4,200</div>
                <div className="stat-label">Steps Today</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon accent"><Brain size={18} /></div>
              <div>
                <div className="stat-value">3</div>
                <div className="stat-label">Social Interactions</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon success"><Clock size={18} /></div>
              <div>
                <div className="stat-value">6.5h</div>
                <div className="stat-label">Active Time</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon warning"><TrendingUp size={18} /></div>
              <div>
                <div className="stat-value">1</div>
                <div className="stat-label">Anomalies</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>Behavioral Insights</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { label: 'Routine Adherence', value: 85, color: 'var(--primary)' },
                { label: 'Social Activity', value: 60, color: 'var(--accent)' },
                { label: 'Physical Activity', value: 72, color: 'var(--success)' },
                { label: 'Sleep Quality', value: 90, color: 'var(--info)' },
              ].map((item, i) => (
                <div key={i}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span className="text-sm">{item.label}</span>
                    <span className="text-sm font-bold">{item.value}%</span>
                  </div>
                  <div style={{ height: 8, background: 'var(--border-light)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      width: `${item.value}%`, height: '100%',
                      background: item.color, borderRadius: 4,
                      transition: 'width 0.5s ease',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
