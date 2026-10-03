import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * D FE-4: two-way voice between a caregiver and the person they look after.
 *
 * ponytail: the browser's own RTCPeerConnection and getUserMedia, no calling
 * SDK and no signalling library. A voice call is three things the platform
 * already provides -- capture a microphone, negotiate a peer connection, play
 * what arrives -- and the signalling is "pass this blob to that user", which
 * the existing Socket.IO connection already does for chat.
 *
 * Audio only. Nobody in an emergency needs video of a ceiling, and audio gets
 * through on a connection that would stall on anything more.
 *
 * The media never touches the server: once the two ends have been introduced
 * the audio goes peer to peer, so the backend is not on the critical path of
 * somebody's emergency and no conversation passes through it to be stored.
 *
 * KNOWN LIMIT: STUN only, no TURN. Two ends behind symmetric NAT (which some
 * mobile networks are) will negotiate and then fail to connect. Fixing that
 * needs a relay server, which is infrastructure rather than code. The state
 * machine surfaces it as 'failed' rather than leaving a silent call open.
 */

// Google's public STUN. It only tells a client what its own public address
// looks like; no audio goes near it.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// idle -> calling | ringing -> connecting -> connected -> ended
export function useVoiceCall(socket, selfId) {
  const [state, setState] = useState('idle');
  const [peer, setPeer] = useState(null);       // { id, name, sos }
  const [error, setError] = useState(null);
  const [muted, setMuted] = useState(false);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioRef = useRef(null);
  // Candidates can arrive before the remote description is set, and adding one
  // then throws. They are held here and flushed once there is somewhere to put
  // them, which is the usual cause of a call that negotiates but stays silent.
  const pendingIce = useRef([]);
  // The offer being rung through, held until it is answered or declined.
  const pendingOffer = useRef(null);

  const cleanup = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      try { pcRef.current.close(); } catch { /* already closed */ }
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      // Without this the browser keeps showing a recording indicator and the
      // microphone stays open after the call has ended.
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }
    pendingIce.current = [];
    setMuted(false);
  }, []);

  const hangUp = useCallback((reason = 'ended', tell = true) => {
    if (tell && socket && peer?.id) socket.emit('call:end', { to: peer.id, reason });
    cleanup();
    setState('ended');
    setPeer(null);
  }, [socket, peer, cleanup]);

  /** A peer connection wired to this socket, plus the microphone. */
  const makePeer = useCallback(async (otherId) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStreamRef.current = stream;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    // A plain <audio> element, created here rather than rendered, so the hook
    // works on any screen without one having to remember to place it.
    const el = document.createElement('audio');
    el.autoplay = true;
    audioRef.current = el;
    pc.ontrack = (e) => { el.srcObject = e.streams[0]; };

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('call:ice', { to: otherId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') setState('connected');
      // 'failed' is usually no TURN rather than anything the user did, so it is
      // shown as a failure to connect rather than as a call that ended.
      if (s === 'failed') { setError('Could not connect'); setState('failed'); cleanup(); }
      if (s === 'disconnected' || s === 'closed') {
        setState(prev => (prev === 'connected' ? 'ended' : prev));
      }
    };
    pcRef.current = pc;
    return pc;
  }, [socket, cleanup]);

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    for (const c of pendingIce.current.splice(0)) {
      try { await pc.addIceCandidate(c); } catch { /* stale candidate */ }
    }
  }, []);

  /** Ring someone. `sos` marks it as raised from an active emergency. */
  const call = useCallback(async (otherId, otherName, sos = false) => {
    if (!socket || state === 'connected' || state === 'calling') return;
    setError(null);
    setPeer({ id: otherId, name: otherName, sos });
    setState('calling');
    try {
      const pc = await makePeer(otherId);
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      socket.emit('call:offer', { to: otherId, sdp: offer, sos });
    } catch (e) {
      // Overwhelmingly a refused microphone permission.
      setError(e.name === 'NotAllowedError' ? 'Microphone permission denied' : e.message);
      cleanup();
      setState('failed');
    }
  }, [socket, state, makePeer, cleanup]);

  /** Pick up the call currently ringing. */
  const answer = useCallback(async () => {
    const incoming = pendingOffer.current;
    if (!socket || !incoming) return;
    setState('connecting');
    try {
      const pc = await makePeer(incoming.from);
      await pc.setRemoteDescription(new RTCSessionDescription(incoming.sdp));
      await flushIce();
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit('call:answer', { to: incoming.from, sdp: ans });
    } catch (e) {
      setError(e.name === 'NotAllowedError' ? 'Microphone permission denied' : e.message);
      hangUp('failed');
      setState('failed');
    }
  }, [socket, makePeer, flushIce, hangUp]);

  const decline = useCallback(() => {
    const incoming = pendingOffer.current;
    if (socket && incoming) socket.emit('call:end', { to: incoming.from, reason: 'declined' });
    pendingOffer.current = null;
    cleanup();
    setState('idle');
    setPeer(null);
  }, [socket, cleanup]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach(t => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  useEffect(() => {
    if (!socket) return undefined;

    const onIncoming = (d) => {
      // Already busy: decline rather than leaving them ringing into nothing.
      if (pcRef.current) {
        socket.emit('call:end', { to: d.from, reason: 'busy' });
        return;
      }
      pendingOffer.current = d;
      setPeer({ id: d.from, name: d.fromName, sos: !!d.sos });
      setState('ringing');
    };

    const onAnswered = async (d) => {
      const pc = pcRef.current;
      if (!pc) return;
      setState('connecting');
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
        await flushIce();
      } catch (e) {
        setError(e.message);
        setState('failed');
      }
    };

    const onIce = async (d) => {
      if (!d.candidate) return;
      const c = new RTCIceCandidate(d.candidate);
      const pc = pcRef.current;
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(c); } catch { /* stale */ }
      } else {
        pendingIce.current.push(c);
      }
    };

    const onEnded = (d) => {
      pendingOffer.current = null;
      cleanup();
      setPeer(null);
      if (d?.reason === 'not_permitted') { setError('You are not connected to this person'); setState('failed'); }
      else if (d?.reason === 'declined') setState('declined');
      else if (d?.reason === 'busy') setState('busy');
      else setState('ended');
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:answered', onAnswered);
    socket.on('call:ice', onIce);
    socket.on('call:ended', onEnded);
    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:answered', onAnswered);
      socket.off('call:ice', onIce);
      socket.off('call:ended', onEnded);
    };
  }, [socket, flushIce, cleanup]);

  // The microphone must not outlive the page.
  useEffect(() => cleanup, [cleanup]);

  return {
    state, peer, error, muted,
    inCall: state === 'calling' || state === 'ringing' || state === 'connecting' || state === 'connected',
    call, answer, decline, hangUp, toggleMute,
    reset: () => { setState('idle'); setError(null); setPeer(null); },
  };
}
