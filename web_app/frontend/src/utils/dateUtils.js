export function formatSmartDate(dateInput) {
  if (!dateInput) return '—';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '—';
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const targetDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  if (targetDate.getTime() === today.getTime()) {
    return `Today at ${timeStr}`;
  } else if (targetDate.getTime() === yesterday.getTime()) {
    return `Yesterday at ${timeStr}`;
  } else {
    // For past notifications/medicines older than today and yesterday, show actual formatted date
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at ${timeStr}`;
  }
}

export function formatTime12Hour(timeStr) {
  if (!timeStr) return '';
  const [hh, mm] = timeStr.split(':');
  if (hh === undefined || mm === undefined) return timeStr;
  let h = parseInt(hh, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  h = h ? h : 12; // 0 should be 12
  return `${h}:${mm} ${ampm}`;
}
