import 'package:flutter/material.dart';

import '../services/voice_call_service.dart';
import '../theme/app_theme.dart';

/// The call, as the person sees it.
///
/// Mounted above the whole app rather than on a screen, because a call can
/// arrive wherever they happen to be and, in an emergency, must not be
/// something that can be scrolled past or dismissed by tapping beside it.
///
/// Knows nothing about WebRTC: it renders what VoiceCallService reports and
/// calls back into it.
class CallOverlay extends StatefulWidget {
  const CallOverlay({super.key, required this.child});
  final Widget child;

  @override
  State<CallOverlay> createState() => _CallOverlayState();
}

class _CallOverlayState extends State<CallOverlay> {
  final _call = VoiceCallService();
  bool _speaker = true;

  @override
  void initState() {
    super.initState();
    _call.addListener(_onChange);
  }

  @override
  void dispose() {
    _call.removeListener(_onChange);
    super.dispose();
  }

  void _onChange() {
    if (!mounted) return;
    setState(() {});
    // A call that has just connected goes to the loudspeaker by default: the
    // person this is built for may not be able to hold a phone to their ear.
    if (_call.state == CallState.connected && _speaker) {
      _call.setSpeaker(true);
    }
  }

  static const _labels = {
    CallState.calling: 'Calling...',
    CallState.ringing: 'Incoming call',
    CallState.connecting: 'Connecting...',
    CallState.connected: 'Connected',
    CallState.declined: 'Call declined',
    CallState.busy: 'They are on another call',
    CallState.failed: 'Could not connect',
    CallState.ended: 'Call ended',
  };

  Widget _circle(IconData icon, Color bg, VoidCallback? onTap, String tip) => Tooltip(
        message: tip,
        child: Material(
          color: bg,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(
              width: 58,
              height: 58,
              child: Icon(icon, color: Colors.white, size: 26),
            ),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final s = _call.state;
    if (s == CallState.idle) return widget.child;

    final live = s == CallState.calling || s == CallState.connecting || s == CallState.connected;
    final over = s == CallState.ended ||
        s == CallState.declined ||
        s == CallState.failed ||
        s == CallState.busy;
    final sos = _call.peerIsSos;

    return Stack(
      children: [
        widget.child,
        Positioned(
          left: 12,
          right: 12,
          bottom: 12,
          child: SafeArea(
            child: Material(
              elevation: 12,
              borderRadius: BorderRadius.circular(18),
              color: AppColors.surface,
              child: Container(
                padding: const EdgeInsets.all(18),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(18),
                  // An emergency call is outlined in red so it is not mistaken
                  // for an ordinary one at a glance.
                  border: Border.all(
                    color: sos ? AppColors.danger : AppColors.border,
                    width: sos ? 2 : 1,
                  ),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (sos)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(children: const [
                          Icon(Icons.warning_amber_rounded, size: 16, color: AppColors.danger),
                          SizedBox(width: 6),
                          Text('EMERGENCY',
                              style: TextStyle(
                                  color: AppColors.danger,
                                  fontWeight: FontWeight.w800,
                                  fontSize: 12,
                                  letterSpacing: 0.6)),
                        ]),
                      ),
                    Text(_call.peerName ?? 'Unknown',
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(_call.error ?? _labels[s] ?? '',
                        style: const TextStyle(fontSize: 14, color: AppColors.textSecondary)),
                    if (s == CallState.connected)
                      const Padding(
                        padding: EdgeInsets.only(top: 6),
                        child: Text('Speaking directly, not through the server.',
                            style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                      ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        if (s == CallState.ringing) ...[
                          _circle(Icons.call, AppColors.success, _call.answer, 'Answer'),
                          const SizedBox(width: 14),
                          _circle(Icons.call_end, AppColors.danger, _call.decline, 'Decline'),
                        ],
                        if (live) ...[
                          _circle(
                            _call.muted ? Icons.mic_off : Icons.mic,
                            _call.muted ? AppColors.warning : AppColors.borderLight,
                            s == CallState.connected ? _call.toggleMute : null,
                            _call.muted ? 'Unmute' : 'Mute',
                          ),
                          const SizedBox(width: 10),
                          _circle(
                            _speaker ? Icons.volume_up : Icons.hearing,
                            AppColors.borderLight,
                            () {
                              setState(() => _speaker = !_speaker);
                              _call.setSpeaker(_speaker);
                            },
                            _speaker ? 'Speaker on' : 'Earpiece',
                          ),
                          const Spacer(),
                          _circle(Icons.call_end, AppColors.danger,
                              () => _call.hangUp(), 'Hang up'),
                        ],
                        if (over)
                          TextButton(
                            onPressed: _call.reset,
                            child: const Text('Close',
                                style: TextStyle(fontWeight: FontWeight.w700)),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
