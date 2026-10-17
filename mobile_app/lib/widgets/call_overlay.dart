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

  /// A call control: the button, and under it the word for what it does.
  ///
  /// This was a Tooltip, which threw "No Overlay widget found" every time a
  /// call started -- see the note at the top of this file. The label is better
  /// visible anyway: a tooltip needs a long press to appear, which is not
  /// something to ask of someone in an emergency.
  Widget _circle(IconData icon, Color bg, VoidCallback? onTap, String label,
          {Color labelColor = AppColors.textSecondary}) =>
      Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Material(
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
          const SizedBox(height: 6),
          Text(label,
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: labelColor)),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final s = _call.state;
    if (s == CallState.idle) return widget.child;

    // A call that simply finished needs no announcement. It used to leave a
    // panel reading "Unknown - Call ended" with a Close button: the name is
    // empty because the call is over and the peer has been cleared, and
    // nobody needs to be told that a call they just hung up has ended.
    //
    // A FAILURE still speaks, because then something went wrong and the
    // person is owed the reason. The test is whether there is anything worth
    // saying, not whether the call is over.
    if ((s == CallState.ended ||
            s == CallState.declined ||
            s == CallState.busy) ||
        (s == CallState.failed && _call.error == null)) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _call.reset());
      return widget.child;
    }

    final live = s == CallState.calling || s == CallState.connecting || s == CallState.connected;
    final over = s == CallState.ended ||
        s == CallState.declined ||
        s == CallState.failed ||
        s == CallState.busy;
    final sos = _call.peerIsSos;

    // While a call is LIVE it takes the whole screen, the way a call does on a
    // phone. Sharing the screen with the page was tried twice -- floating over
    // it buried the emergency panel's buttons, and splitting the height
    // squeezed the page -- and both failed for the same reason: to the person
    // on the call, the call is not decoration on a page, it is the page.
    if (live || s == CallState.ringing) return _fullScreen(s, sos);

    // Once it is over, the small panel is right again: the call is finished
    // and the page behind it is what they want back.
    return Column(
      children: [
        Expanded(child: widget.child),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: SafeArea(
            top: false,
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
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    // The error strings are full sentences, so this one wraps
                    // rather than truncating: "Not connected to LOCUS" cut off
                    // at the edge tells the reader nothing.
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

  /// The call, filling the screen. Large text and large targets, because the
  /// person holding the phone may be frightened, far-sighted, or both.
  Widget _fullScreen(CallState s, bool sos) {
    final connected = s == CallState.connected;
    final ringing = s == CallState.ringing;
    return Material(
      color: sos ? AppColors.danger : AppColors.primary,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          child: Column(
            children: [
              if (sos)
                const Text('EMERGENCY CALL',
                    style: TextStyle(
                        color: Colors.white70,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.4)),
              const Spacer(),
              CircleAvatar(
                radius: 48,
                backgroundColor: Colors.white24,
                child: Text(
                  (_call.peerName ?? '?').characters.first.toUpperCase(),
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 40,
                      fontWeight: FontWeight.w700),
                ),
              ),
              const SizedBox(height: 20),
              Text(
                _call.peerName ?? 'Unknown',
                textAlign: TextAlign.center,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 28,
                    fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 8),
              Text(
                _call.error ?? _labels[s] ?? '',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70, fontSize: 16),
              ),
              const Spacer(),
              // Wrap, so the controls fall onto a second line rather than off
              // the edge when the system font size is turned up.
              Wrap(
                alignment: WrapAlignment.center,
                spacing: 24,
                runSpacing: 16,
                children: [
                  if (ringing) ...[
                    _circle(Icons.call, AppColors.success, _call.answer,
                        'Answer', labelColor: Colors.white),
                    _circle(Icons.call_end, Colors.white24, _call.decline,
                        'Decline', labelColor: Colors.white),
                  ] else ...[
                    _circle(
                      _call.muted ? Icons.mic_off : Icons.mic,
                      Colors.white24,
                      connected ? _call.toggleMute : null,
                      _call.muted ? 'Unmute' : 'Mute',
                      labelColor: Colors.white,
                    ),
                    _circle(Icons.call_end, AppColors.danger,
                        () => _call.hangUp(), 'Hang up',
                        labelColor: Colors.white),
                    _circle(
                      _speaker ? Icons.volume_up : Icons.hearing,
                      Colors.white24,
                      () {
                        setState(() => _speaker = !_speaker);
                        _call.setSpeaker(_speaker);
                      },
                      _speaker ? 'Speaker on' : 'Earpiece',
                      labelColor: Colors.white,
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }

}
