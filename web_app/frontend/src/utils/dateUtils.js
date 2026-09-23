/**
 * A clock time, always 12-hour: "2:05 PM".
 *
 * Every caller used to pass toLocaleTimeString([], ...) with no hour12, which
 * lets the BROWSER's locale decide. That is how the same event read 14:05 on
 * one machine and 2:05 PM on another, and why times were inconsistent between
 * pages. Passing hour12 explicitly makes the app's own choice, everywhere.
 */
export function formatClockTime(dateInput) {
  if (!dateInput) return '';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** A date and 12-hour time together: "24 Sep 2026, 2:05 PM". */
export function formatDateTime12h(dateInput) {
  if (!dateInput) return '';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}, ${formatClockTime(d)}`;
}

export function formatSmartDate(dateInput) {
  if (!dateInput) return '—';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '—';
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const targetDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  
  const timeStr = formatClockTime(d);
  
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
