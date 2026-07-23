import { useEffect } from 'react';

export const useKeyframeSync = () => {
  // Syncing to local IndexedDB is now disabled.
  // Keyframes are stored centrally on the server to allow cross-device viewing
  // (e.g., both Web and Mobile apps can access them directly).
  
  useEffect(() => {
    // No-op
  }, []);
};
