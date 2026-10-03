import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'socket_service.dart';

/// D FE-4: a voice call between the wearer and their caregiver.
///
/// The mirror of the web's useVoiceCall, speaking the same four signalling
/// events over the Socket.IO connection the app already holds, so a phone and a
/// browser can call each other without either side knowing what the other is.
/// Both are libwebrtc underneath.
///
/// The audio goes peer to peer. The server introduces the two ends and then has
/// no part in the call, which is why an emergency conversation does not depend
/// on the backend staying up, and why none of it is stored anywhere.
///
/// KNOWN LIMIT: STUN only, no TURN, the same as the web side. Two ends behind
/// symmetric NAT, which some mobile networks are, will negotiate and then fail
/// to connect. That needs a relay server rather than more code, and it surfaces
/// as CallState.failed rather than as a silent open call.
enum CallState { idle, calling, ringing, connecting, connected, ended, declined, busy, failed }

class VoiceCallService extends ChangeNotifier {
  static final VoiceCallService _instance = VoiceCallService._internal();
  factory VoiceCallService() => _instance;
  VoiceCallService._internal();

  // Google's public STUN. It only tells a client what its own public address
  // looks like; no audio goes near it.
  static const Map<String, dynamic> _config = {
    'iceServers': [
      {'urls': 'stun:stun.l.google.com:19302'},
    ],
  };

  RTCPeerConnection? _pc;
  MediaStream? _localStream;
  // Candidates can arrive before the remote description is set, and adding one
  // then throws. They wait here until there is somewhere to put them, which is
  // the usual reason a call connects and stays silent.
  final List<RTCIceCandidate> _pendingIce = [];
  Map<String, dynamic>? _pendingOffer;

  CallState state = CallState.idle;
  String? peerId;
  String? peerName;
  bool peerIsSos = false;
  bool muted = false;
  String? error;
  bool _wired = false;

  bool get inCall =>
      state == CallState.calling ||
      state == CallState.ringing ||
      state == CallState.connecting ||
      state == CallState.connected;

  void _set(CallState s) {
    state = s;
    notifyListeners();
  }

  // ── signalling ───────────────────────────────────────────────────────

  /// Starts listening for calls. Safe to call repeatedly.
  void init() {
    if (_wired) return;
    final socket = SocketService().socket;
    if (socket == null) return;
    _wired = true;

    socket.on('call:incoming', (data) async {
      final d = Map<String, dynamic>.from(data as Map);
      if (_pc != null) {
        // Already on a call: decline rather than leave them ringing at nothing.
        socket.emit('call:end', {'to': d['from'], 'reason': 'busy'});
        return;
      }
      _pendingOffer = d;
      peerId = d['from']?.toString();
      peerName = d['fromName']?.toString();
      peerIsSos = d['sos'] == true;
      _set(CallState.ringing);
    });

    socket.on('call:answered', (data) async {
      final d = Map<String, dynamic>.from(data as Map);
      final pc = _pc;
      if (pc == null) return;
      _set(CallState.connecting);
      try {
        final sdp = Map<String, dynamic>.from(d['sdp'] as Map);
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?));
        await _flushIce();
      } catch (e) {
        error = e.toString();
        _set(CallState.failed);
      }
    });

    socket.on('call:ice', (data) async {
      final d = Map<String, dynamic>.from(data as Map);
      final c = Map<String, dynamic>.from(d['candidate'] as Map);
      final cand = RTCIceCandidate(
          c['candidate'] as String?, c['sdpMid'] as String?, c['sdpMLineIndex'] as int?);
      final pc = _pc;
      if (pc == null) {
        _pendingIce.add(cand);
        return;
      }
      final remote = await pc.getRemoteDescription();
      if (remote != null) {
        try {
          await pc.addCandidate(cand);
        } catch (_) {
          // Stale candidate for a connection that has moved on.
        }
      } else {
        _pendingIce.add(cand);
      }
    });

    socket.on('call:ended', (data) {
      final d = Map<String, dynamic>.from(data as Map);
      final reason = d['reason']?.toString();
      _teardown();
      _pendingOffer = null;
      peerId = null;
      if (reason == 'not_permitted') {
        error = 'You are not connected to this person';
        _set(CallState.failed);
      } else if (reason == 'declined') {
        _set(CallState.declined);
      } else if (reason == 'busy') {
        _set(CallState.busy);
      } else {
        _set(CallState.ended);
      }
    });
  }

  Future<void> _flushIce() async {
    final pc = _pc;
    if (pc == null) return;
    for (final c in List<RTCIceCandidate>.of(_pendingIce)) {
      try {
        await pc.addCandidate(c);
      } catch (_) {/* stale */}
    }
    _pendingIce.clear();
  }

  // ── the connection ───────────────────────────────────────────────────

  Future<RTCPeerConnection> _makePeer(String otherId) async {
    // Asking for the microphone is also what triggers the runtime permission
    // prompt, so a refusal surfaces here as an exception rather than as a call
    // that connects to silence.
    _localStream = await navigator.mediaDevices
        .getUserMedia({'audio': true, 'video': false});

    final pc = await createPeerConnection(_config);
    for (final track in _localStream!.getTracks()) {
      await pc.addTrack(track, _localStream!);
    }

    final socket = SocketService().socket;
    pc.onIceCandidate = (c) {
      if (c.candidate == null) return;
      socket?.emit('call:ice', {
        'to': otherId,
        'candidate': {
          'candidate': c.candidate,
          'sdpMid': c.sdpMid,
          'sdpMLineIndex': c.sdpMLineIndex,
        },
      });
    };
    pc.onConnectionState = (s) {
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _set(CallState.connected);
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        // Almost always the missing TURN rather than anything the user did.
        error = 'Could not connect';
        _teardown();
        _set(CallState.failed);
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateClosed ||
          s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        if (state == CallState.connected) _set(CallState.ended);
      }
    };
    _pc = pc;
    return pc;
  }

  /// Ring someone. [sos] marks a call raised from an active emergency.
  Future<void> call(String otherId, String otherName, {bool sos = false}) async {
    final socket = SocketService().socket;
    if (socket == null || inCall) return;
    init();
    error = null;
    peerId = otherId;
    peerName = otherName;
    peerIsSos = sos;
    _set(CallState.calling);
    try {
      final pc = await _makePeer(otherId);
      final offer = await pc.createOffer({'offerToReceiveAudio': true});
      await pc.setLocalDescription(offer);
      socket.emit('call:offer', {
        'to': otherId,
        'sdp': {'sdp': offer.sdp, 'type': offer.type},
        'sos': sos,
      });
    } catch (e) {
      error = _friendly(e);
      _teardown();
      _set(CallState.failed);
    }
  }

  /// Pick up the call that is ringing.
  Future<void> answer() async {
    final socket = SocketService().socket;
    final incoming = _pendingOffer;
    if (socket == null || incoming == null) return;
    _set(CallState.connecting);
    try {
      final from = incoming['from'].toString();
      final pc = await _makePeer(from);
      final sdp = Map<String, dynamic>.from(incoming['sdp'] as Map);
      await pc.setRemoteDescription(
          RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?));
      await _flushIce();
      final ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit('call:answer', {
        'to': from,
        'sdp': {'sdp': ans.sdp, 'type': ans.type},
      });
      _pendingOffer = null;
    } catch (e) {
      error = _friendly(e);
      hangUp(reason: 'failed');
      _set(CallState.failed);
    }
  }

  void decline() {
    final socket = SocketService().socket;
    final incoming = _pendingOffer;
    if (socket != null && incoming != null) {
      socket.emit('call:end', {'to': incoming['from'], 'reason': 'declined'});
    }
    _pendingOffer = null;
    _teardown();
    peerId = null;
    _set(CallState.idle);
  }

  void hangUp({String reason = 'ended', bool tell = true}) {
    final socket = SocketService().socket;
    if (tell && socket != null && peerId != null) {
      socket.emit('call:end', {'to': peerId, 'reason': reason});
    }
    _teardown();
    peerId = null;
    _set(CallState.ended);
  }

  void toggleMute() {
    final stream = _localStream;
    if (stream == null) return;
    muted = !muted;
    for (final t in stream.getAudioTracks()) {
      t.enabled = !muted;
    }
    notifyListeners();
  }

  /// Route the call to the loudspeaker, for someone holding a phone they cannot
  /// hold to their ear.
  Future<void> setSpeaker(bool on) async {
    try {
      await Helper.setSpeakerphoneOn(on);
    } catch (e) {
      debugPrint('speakerphone: $e');
    }
  }

  void reset() {
    error = null;
    peerId = null;
    peerName = null;
    peerIsSos = false;
    _set(CallState.idle);
  }

  String _friendly(Object e) {
    final s = e.toString();
    // The shape a refused microphone takes on Android.
    if (s.contains('NotAllowed') || s.contains('Permission')) {
      return 'Microphone permission denied';
    }
    return s;
  }

  void _teardown() {
    // Order matters: tracks are stopped before the stream is disposed, or the
    // microphone stays open and Android keeps showing the in-use indicator.
    final stream = _localStream;
    if (stream != null) {
      for (final t in stream.getTracks()) {
        t.stop();
      }
      stream.dispose();
      _localStream = null;
    }
    _pc?.close();
    _pc = null;
    _pendingIce.clear();
    muted = false;
  }

  @override
  void dispose() {
    _teardown();
    super.dispose();
  }
}
