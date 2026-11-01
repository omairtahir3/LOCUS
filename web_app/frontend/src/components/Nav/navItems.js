import {
  Home, Users, Activity, MapPin, Bell, Pill, Package,
  Search, CalendarClock, Images, Settings,
} from 'lucide-react';

/**
 * One source of truth for where a role can go.
 *
 * The sidebar kept FOUR arrays -- caregiverNavItems, caregiverMonitorItems,
 * userNavItems, userMonitorItems -- split across a "Main" and a "Monitoring"
 * heading that described how the team thinks about the system rather than
 * anything the reader wants. A person looking for the location map does not
 * first decide whether locating someone is monitoring.
 *
 * Routes are untouched: every `to` below already exists in App.jsx, and the
 * role guards on those routes are unchanged. This file decides what is
 * ADVERTISED, never what is permitted.
 *
 * Settings is deliberately absent. It lives in the profile menu, where an
 * account-level destination belongs, which also keeps the dock to seven items
 * and under its own width budget.
 */

// `primary` marks the four that survive into the bottom tab bar under 900px.
// Chosen by what someone opens the app to find, not by menu order.
export const WEARER_ITEMS = [
  { to: '/my-dashboard',   label: 'Today',      icon: Home,          primary: true, end: true },
  { to: '/routine',        label: 'Routine',    icon: CalendarClock },
  { to: '/belongings',     label: 'Belongings', icon: Package,       primary: true },
  { to: '/relationships',  label: 'People',     icon: Users,         primary: true, badge: 'faces' },
  { to: '/memory-search',  label: 'Memory',     icon: Search },
  { to: '/my-medications', label: 'Medication', icon: Pill,          primary: true },
];

export const CAREGIVER_ITEMS = [
  { to: '/family',         label: 'Family',     icon: Users,         primary: true },
  { to: '/dashboard',      label: 'Today',      icon: Home,          primary: true, end: true },
  { to: '/routine',        label: 'Routine',    icon: CalendarClock },
  { to: '/activity',       label: 'Activity',   icon: Activity },
  { to: '/location',       label: 'Location',   icon: MapPin },
  // The existing /notifications route, relabelled. "Notifications" names the
  // delivery mechanism; "Alerts" names what the reader is looking for.
  { to: '/notifications',  label: 'Alerts',     icon: Bell,          primary: true },
  { to: '/medications',    label: 'Medication', icon: Pill },
];

export const isCaregiver = (user) =>
  user?.role === 'caregiver' || user?.role === 'admin';

export const itemsFor = (user) =>
  isCaregiver(user) ? CAREGIVER_ITEMS : WEARER_ITEMS;

/**
 * Reachable, but not dock destinations.
 *
 * "Recent keyframes" was briefly a dock item and is folded back under People:
 * the label was half again as long as any other, which broke the dock's
 * rhythm, and confirming a face is something you go and do rather than a
 * place you visit. The waiting count rides on People instead, and the page
 * is reachable from there, from the People card on Today, from the command
 * palette, and from the More sheet.
 */
export const EXTRA_DESTINATIONS = [
  { to: '/keyframes', label: 'Review faces', icon: Images, hint: 'Confirm or dismiss unknown faces' },
  { to: '/settings',  label: 'Settings',     icon: Settings, hint: 'Profile, privacy and storage' },
];
