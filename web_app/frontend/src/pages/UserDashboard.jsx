import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import DaySummary from '../components/Today/DaySummary';

/**
 * The wearer's day.
 *
 * WHAT THIS PAGE USED TO BE
 *
 * Five hundred lines, and all but the greeting was about medicine: a hero card
 * for the next dose, two square stats ("Taken Today", "Weekly Goal"), a
 * "Today's Timeline" that listed only doses, a "Weekly Progress" ring, and a
 * "Health Tip" with a hardcoded paragraph about consistency. Medication has
 * three pages of its own -- My Medications, History, and the detection
 * evidence -- so every one of those was a second, thinner copy of something
 * that already existed and was better.
 *
 * It also held "My Live AI Monitor", subtitled "Real-time camera feed & AI
 * status", which showed neither. That is a pairing step and has moved to
 * Settings (see components/Camera/CameraSetup).
 *
 * Deleted with them, because nothing called any of it: markAsTaken,
 * markAsMissed, markAsCameraOff, dismissMed, snoozeMed, saveCameraConfig and
 * the adherence arithmetic. The dose buttons on this page were never wired to
 * the buttons on screen -- the real ones live on My Medications.
 *
 * What is left is the day: rooms, activities, people, belongings, routine,
 * location, alerts, and medication as one card among them.
 */
export default function UserDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Unchanged guard: UserOnlyRoute does this too, but a caregiver who lands
  // here by a stale link should not sit on an empty page.
  useEffect(() => {
    if (user && (user.role === 'caregiver' || user.role === 'admin')) {
      navigate('/dashboard', { replace: true });
    }
  }, [user, navigate]);

  // homeLocation is deliberately NOT passed.
  //
  // It drove one thing on this page: the "Away / At home" pill in the header.
  // That pill is a caregiver's reading of somebody else -- it answers "is the
  // person I look after where I expect them to be". A normal user has no
  // caregiver, so there is nobody for it to answer to, and telling someone
  // standing in their own kitchen that they are "At home" is noise at best.
  //
  // Without the prop, `away` stays null and the pill does not render. The
  // Location card below it was already caregiver-only (canAct), so nothing
  // else on this page changes.
  return (
    <DaySummary self name={user?.name} />
  );
}
