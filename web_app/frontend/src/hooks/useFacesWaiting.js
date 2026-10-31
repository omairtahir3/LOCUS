import { useEffect, useState } from 'react';
import { eventLogsAPI } from '../services/api';

/**
 * How many unknown faces are waiting to be named.
 *
 * Drives the badge on the People dock item, because Keyframe Audit is no
 * longer a dock destination -- it sits under People as "Review faces" -- and a
 * screen nobody is told about is a screen nobody opens. A face waiting for a
 * name is the one thing on that page with a deadline: the keyframe behind it
 * is deleted after KEYFRAME_TTL_HOURS.
 *
 * The same endpoint Keyframe Audit itself uses, so the badge and the page can
 * never disagree. Five minutes: a face arrives when somebody walks in, which
 * is not a thing worth polling hard for.
 */
const POLL_MS = 300000;

export function useFacesWaiting() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const res = await eventLogsAPI.getKeyframes({ type: 'unknown_face', limit: 50 });
        if (alive) setCount(Array.isArray(res.data) ? res.data.length : 0);
      } catch {
        // Leave the last known count. A badge that vanishes on a failed
        // request says "nothing to do", which is the wrong answer.
      }
    };
    read();
    const t = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return count;
}
