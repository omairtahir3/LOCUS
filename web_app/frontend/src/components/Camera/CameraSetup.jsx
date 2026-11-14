import { useEffect, useState } from 'react';
import { Camera, Copy, Check } from 'lucide-react';
import { authAPI } from '../../services/api';
import { useAuth } from '../../context/AuthContext';

/**
 * Where a camera is pointed at LOCUS.
 *
 * This lived on the wearer's main page as a card called "My Live AI Monitor",
 * subtitled "Real-time camera feed & AI status". It showed neither: the card
 * body was empty and the only control opened a modal that displayed an RTMP
 * address with a Close button. Nothing was live and nothing was a status.
 *
 * It is a setup step -- done once, when a camera is first paired -- so it
 * belongs with the other things you configure once, not on the screen somebody
 * opens every morning to see how their day is going.
 *
 * The dead parts went with the move: saveCameraConfig, savingConfig and
 * cameraUrl were an editing path for a dialog that had no field to edit, so
 * the handler could never run.
 *
 * ponytail: navigator.clipboard with a text fallback rather than a copy
 * library. The address is the whole point of the panel, and it is long enough
 * that retyping it is where pairing goes wrong.
 */
export default function CameraSetup() {
  const { user } = useAuth();
  const [host, setHost] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    authAPI.getRtmpHost()
      .then(res => { if (alive) setHost(res.data.host); })
      .catch(() => { if (alive) setHost(window.location.hostname); });
    return () => { alive = false; };
  }, []);

  const url = `rtmp://${host || window.location.hostname}/live/${user?._id || ''}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Older browsers, and any page not served over https, have no clipboard
      // API. The address is selectable either way, so this only loses the
      // one-tap convenience.
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="card mb-4">
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Camera size={18} />
          <div>
            <div className="card-title">Camera</div>
            <div className="card-subtitle">Point a camera at LOCUS</div>
          </div>
        </div>
      </div>

      <div className="camera-setup">
        <p className="camera-setup-lead">
          Open your camera's streaming settings, choose RTMP, and paste this
          address. It is unique to this account.
        </p>

        <div className="camera-url">
          <code>{url}</code>
          <button className="btn btn-secondary btn-sm" onClick={copy}>
            {copied
              ? <><Check size={14} aria-hidden="true" /> Copied</>
              : <><Copy size={14} aria-hidden="true" /> Copy</>}
          </button>
        </div>

        <p className="camera-setup-note">
          Most action cameras and phone streaming apps call this field "RTMP
          URL" or "Server URL". Nothing needs to be entered here afterwards —
          frames arrive on their own once the camera starts streaming.
        </p>
      </div>
    </div>
  );
}
