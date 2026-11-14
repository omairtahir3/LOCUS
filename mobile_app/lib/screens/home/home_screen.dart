import 'dart:async';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:url_launcher/url_launcher.dart';
import '../../widgets/day_summary.dart';
import '../chat/chat_screen.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/location_service.dart';
import '../../services/step_service.dart';
import '../../services/socket_service.dart';
import '../../services/voice_call_service.dart';

class HomeScreen extends StatefulWidget {
  /// Whether this is the tab the person is actually looking at. The shell
  /// keeps every tab mounted, and the SOS voice listener must not hold the
  /// microphone while somebody is using it somewhere else.
  final bool isVisible;

  const HomeScreen({super.key, this.isVisible = true});

  @override
  State<HomeScreen> createState() => HomeScreenState();
}

class HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  bool _isEmergencyActive = false;

  Timer? _refreshTimer;

  // -- "I'm lost", said out loud (Module D FE-2) ----------------------------
  //
  // The panic button below is already one tap, so a voice path that ALSO
  // needed a tap would add nothing at all. The point of saying it is that it
  // is hands-free: somebody disoriented enough to need this is not reliably
  // going to find a button, and may be holding the phone without looking at
  // it.
  //
  // It listens only while this screen is in front of them, only while the app
  // is in the foreground, and only once they have switched it on -- which
  // keeps the battery and privacy cost somewhere they can see and undo. The
  // microphone indicator is visible the whole time it is open, because a
  // microphone nobody can tell is running is the thing worth avoiding.
  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _voiceArmed = false;   // their choice, remembered between launches
  bool _voiceReady = false;   // plugin initialised and permission granted
  bool _hearing = false;      // the microphone is open right now
  Timer? _sosCountdown;       // the cancellable pause before alerting anyone
  static const String _prefVoiceArmed = 'sos_voice_armed';

  // Deliberately NOT a bare "lost". "I lost my glasses" is a sentence people
  // say in the room they are standing in, and raising a caregiver alert for it
  // would teach them to switch this off -- which costs far more than the
  // occasional missed phrasing.
  static const List<String> _sosPhrases = [
    "i'm lost", "im lost", "i am lost",
    "help me", "i need help", "need help",
  ];

  @override
  void initState() {
    super.initState();
    
    // Connect to websocket so Elderly users can chat
    SocketService().init();
    // Listening for calls starts where the socket does: a client that is not
    // listening cannot be rung, which is the whole feature.
    VoiceCallService().init();
    SocketService().connect();
    SocketService().addSosResolvedListener(_handleSosResolved);

    WidgetsBinding.instance.addObserver(this);
    // A call starting has to close the recogniser, not merely stop it being
    // opened again: the wearer can be listening when the phone rings.
    VoiceCallService().addListener(_onCallStateChanged);
    _loadData();
    _refreshTimer = Timer.periodic(const Duration(seconds: 10), (_) => _loadData());
    // Only the person being looked after has an SOS button to speak instead of.
    if (_isElderly) _restoreVoicePreference();
    
    // Start tracking location if elderly or user (normal user)
    if (ApiService.userRole == 'elderly' || ApiService.userRole == 'user') {
      LocationService().startTracking().catchError((e) {
        print("Failed to start location tracking: $e");
      });
      // Step counting, for the Activity Feed. A phone with no step sensor, or
      // a denied activity-recognition permission, simply reports nothing; it
      // is not an error worth interrupting the user for.
      if (!kIsWeb) {
        StepService().start().catchError((e) {
          debugPrint("Failed to start step counting: $e");
        });
      }
    }
  }

  bool get _isElderly => ApiService.userRole == 'elderly';
  bool get _isMonitoredUser => ApiService.userRole == 'elderly' || ApiService.userRole == 'user';

  void reload() => _loadData();

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _sosCountdown?.cancel();
    VoiceCallService().removeListener(_onCallStateChanged);
    _speech.cancel();
    WidgetsBinding.instance.removeObserver(this);
    SocketService().removeSosResolvedListener(_handleSosResolved);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The microphone closes with the app, every time. Listening on in the
    // background would be a different product from the one described on this
    // screen, and not one anybody agreed to.
    if (state == AppLifecycleState.resumed) {
      if (_voiceArmed) _listenForSos();
      // And put the socket back up.
      //
      // Android suspends an app's network while the screen is off, so the
      // socket dies in the background -- the device log shows exactly that:
      // "[Socket] Could not connect: timeout", repeatedly, and then nothing.
      // socket_io_client does retry, but it backs off, so a phone that has
      // been asleep for a while can come back to a connection that will not
      // be re-attempted for a long time. By then calls do not ring and the
      // live map does not move, while anything fetched over plain HTTP still
      // works -- which is why this reads as "messages arrive but calls do
      // not" rather than as a network problem.
      //
      // connect() goes through init(), which is idempotent and rebuilds only
      // if the token or the address has changed, so this is cheap when the
      // socket is already healthy.
      SocketService().connect();
      _loadData();
    } else {
      _speech.stop();
      if (mounted) setState(() => _hearing = false);
    }
  }

  @override
  void didUpdateWidget(covariant HomeScreen old) {
    super.didUpdateWidget(old);
    if (widget.isVisible == old.isVisible) return;
    if (widget.isVisible) {
      if (_voiceArmed) _listenForSos();
    } else {
      // Leaving the tab releases the microphone for whoever is in front.
      _speech.stop();
      if (_hearing) setState(() => _hearing = false);
    }
  }

  void _onCallStateChanged() {
    if (!mounted) return;
    if (VoiceCallService().inCall) {
      // Give the microphone up immediately. Waiting for the recogniser's own
      // timeout would leave the first seconds of the call without audio.
      _speech.stop();
      if (_hearing) setState(() => _hearing = false);
    } else if (_voiceArmed) {
      _listenForSos();
    }
  }

  Future<void> _restoreVoicePreference() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_prefVoiceArmed) ?? false) {
      await _setVoiceArmed(true, persist: false);
    }
  }

  Future<void> _setVoiceArmed(bool on, {bool persist = true}) async {
    if (on && !_voiceReady) {
      // Asked for here rather than at startup, so the request arrives with a
      // reason attached: they have just chosen to be listened to.
      final status = await Permission.microphone.request();
      if (!status.isGranted) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Microphone access is needed to listen for "I\'m lost"'),
          ));
        }
        return;
      }
      _voiceReady = await _speech.initialize(
        // The recogniser stops by itself after a pause in speech, so both of
        // these exist to re-open the ear rather than to report anything. An
        // error here is usually ordinary silence; disarming on it would leave
        // somebody believing they could be heard when they could not.
        onStatus: (st) {
          if (mounted && _voiceArmed && !_speech.isListening) _listenForSos();
        },
        onError: (_) {
          if (mounted && _voiceArmed) _listenForSos();
        },
      );
      if (!_voiceReady) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Speech recognition is not available on this phone'),
          ));
        }
        return;
      }
    }
    if (mounted) setState(() => _voiceArmed = on);
    if (persist) {
      (await SharedPreferences.getInstance()).setBool(_prefVoiceArmed, on);
    }
    if (on) {
      _listenForSos();
    } else {
      await _speech.stop();
      if (mounted) setState(() => _hearing = false);
    }
  }

  Future<void> _listenForSos() async {
    if (!_voiceArmed || !_voiceReady) return;
    if (_speech.isListening || _isEmergencyActive || _sosCountdown != null) return;
    // A call owns the microphone. Android hands it to one consumer at a time,
    // and opening the recogniser here took audio focus away from WebRTC --
    // breaking the call this feature exists to start. Listening resumes when
    // the call ends; see _onCallStateChanged.
    if (VoiceCallService().inCall) return;
    // Not the tab in front of them: the microphone belongs to whatever is.
    if (!widget.isVisible) return;
    if (mounted) setState(() => _hearing = true);
    await _speech.listen(
      // Partial results, because the phrase should act while it is being said
      // rather than after the recogniser decides the sentence has ended.
      onResult: (r) => _onHeard(r.recognizedWords),
      listenFor: const Duration(minutes: 1),
      pauseFor: const Duration(seconds: 6),
      partialResults: true,
      cancelOnError: false,
    );
  }

  void _onHeard(String words) {
    if (_sosCountdown != null || _isEmergencyActive) return;
    final said = words.toLowerCase();
    if (!_sosPhrases.any(said.contains)) return;
    _speech.stop();
    if (mounted) setState(() => _hearing = false);
    _startSosCountdown();
  }

  void _startSosCountdown() {
    // Five seconds between hearing it and acting on it. A phrase can be
    // overheard from somebody else's conversation or from a television, and
    // five seconds is long enough to say no while being short enough not to
    // matter when it is real.
    _sosCountdown = Timer(const Duration(seconds: 5), () {
      _sosCountdown = null;
      _raiseEmergency();
    });
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      duration: const Duration(seconds: 5),
      backgroundColor: AppColors.danger,
      content: const Text('Heard you. Alerting your caregiver...',
          style: TextStyle(fontWeight: FontWeight.w700)),
      action: SnackBarAction(
        label: 'Cancel',
        textColor: Colors.white,
        onPressed: () {
          _sosCountdown?.cancel();
          _sosCountdown = null;
          _listenForSos();
        },
      ),
    ));
  }

  Future<void> _raiseEmergency() async {
    // One path for both ways of asking for help, so the spoken route cannot
    // drift from the button route.
    //
    // THE ALERT GOES OUT WHETHER OR NOT THERE IS A FIX. This used to return
    // early when getCurrentPosition() came back null -- indoors, with a cold
    // GPS, or with location switched off -- so pressing "I'm lost" raised
    // nothing at all and showed a toast to the one person who already knew
    // they were lost. Nobody was told. A position is what the caregiver wants
    // second; being told at all is what they need first, and the server fills
    // the position in from the last fix the phone reported.
    try {
      double? lat, lng;
      try {
        final pos = await LocationService().getCurrentPosition();
        if (pos != null) {
          lat = pos.latitude;
          lng = pos.longitude;
        }
      } catch (_) {
        // A location failure must not take the emergency with it.
      }
      await ApiService.triggerEmergencySos(lat: lat, lng: lng);
      if (mounted) {
        setState(() => _isEmergencyActive = true);
        if (lat == null) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Help has been called. Your last known position '
                'was sent, because there is no GPS signal right now.'),
            duration: Duration(seconds: 6),
          ));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Error: $e')));
      }
    }
  }

  void _handleSosResolved(Map<String, dynamic> data) {
    // Fires when a caregiver resolves this user's SOS remotely (self-cancel
    // takes the local button path instead and never reaches this listener).
    if (mounted && _isEmergencyActive) {
      setState(() => _isEmergencyActive = false);
      final resolver = data['resolver_name'] ?? 'your caregiver';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Your emergency was resolved by $resolver.'),
          backgroundColor: AppColors.success,
        ),
      );
    }
  }

  /// Refreshing this screen means refreshing the day, which DaySummary owns.
  /// The ten-second timer and the pull-to-refresh both come through here, so
  /// there is one path to a reload rather than two that can disagree.
  Future<void> _loadData() async {
    await _bento.currentState?.load();

    // And whether this person is actually in an emergency.
    //
    // _isEmergencyActive was set when they pressed the button and cleared only
    // by the sos_resolved event. A client that missed that event -- backgrounded,
    // socket down, app restarted -- kept the red panel up forever, saying
    // EMERGENCY ACTIVE about an emergency a caregiver had already resolved.
    // This runs on the same ten-second refresh the rest of the page uses, so a
    // missed event now costs ten seconds instead of the whole session.
    //
    // Only ever used to CLEAR a stale flag, never to raise one: a raise is a
    // decision the person makes here, and _raiseEmergency owns it.
    final me = await ApiService.refreshMe();
    if (!mounted || me == null) return;
    if (_isEmergencyActive && me['emergency_status'] != true) {
      setState(() => _isEmergencyActive = false);
    }
  }

  /// The day, from the shared widget both dashboards use. The camera banner
  /// and the SOS control are slotted in above the cards: they are the two
  /// things on a wearer's screen that cannot wait behind a scroll.
  final GlobalKey<DaySummaryState> _bento = GlobalKey<DaySummaryState>();

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async {
        await _loadData();
        await _bento.currentState?.load();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
        child: DaySummary(
          key: _bento,
          isElderly: _isElderly,
          isMonitoredUser: _isMonitoredUser,
          beforeCards: [
            _buildRtmpBanner(),
            if (_isElderly) _buildSOSSection(),
          ],
        ),
      ),
    );
  }

  /// Ring the caregiver who watches this account.
  ///
  /// Looked up rather than remembered, because an account can gain a caregiver
  /// after the app started, and someone in an emergency should not have to
  /// restart it to be able to call for help.
  Future<void> _callCaregiver() async {
    try {
      final caregivers = await ApiService.getLinkedCaregivers();
      if (caregivers.isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('No caregiver is linked to your account yet.'),
          ));
        }
        return;
      }
      final c = caregivers.first;
      await VoiceCallService().call(
        c['_id'].toString(), c['name']?.toString() ?? 'Caregiver', sos: true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not start the call: $e')));
      }
    }
  }

  Widget _buildSOSSection() {
    if (_isEmergencyActive) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: AppColors.danger,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: AppColors.danger.withAlpha(100), blurRadius: 20, spreadRadius: 5)
          ],
        ),
        child: Column(
          children: [
            const Icon(Icons.warning_amber_rounded, color: Colors.white, size: 64),
            const SizedBox(height: 12),
            const Text("EMERGENCY ACTIVE", style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w900, letterSpacing: 1.5)),
            const SizedBox(height: 8),
            const Text("Help is on the way. Your caregiver has been notified of your location.", textAlign: TextAlign.center, style: TextStyle(color: Colors.white70, fontSize: 14)),
            const SizedBox(height: 24),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 12,
              runSpacing: 12,
              children: [
                // D FE-4, where it matters most: during an active emergency the
                // wearer can reach a voice rather than only being tracked. The
                // sos flag makes it arrive on the caregiver's side marked as an
                // emergency instead of as an ordinary call.
                ElevatedButton.icon(
                  onPressed: _callCaregiver,
                  icon: const Icon(Icons.call, size: 18),
                  label: const Text('Call Caregiver',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: AppColors.danger,
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
                  ),
                ),
                ElevatedButton(
                  onPressed: () async {
                    try {
                      await ApiService.cancelEmergency();
                      if (mounted) setState(() => _isEmergencyActive = false);
                    } catch (e) {
                      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
                    }
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: AppColors.danger,
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
                  ),
                  child: const Text("I'm Safe Now", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                ),
                ElevatedButton.icon(
                  onPressed: () async {
                    final home = ApiService.user?['home_location'];
                    if (home != null && home['lat'] != null && home['lng'] != null) {
                      final url = 'https://www.google.com/maps/dir/?api=1&destination=${home['lat']},${home['lng']}&travelmode=walking';
                      if (await canLaunchUrl(Uri.parse(url))) {
                        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
                      } else {
                        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not launch maps')));
                      }
                    } else {
                      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Home location not set in Settings')));
                    }
                  },
                  icon: const Icon(Icons.home),
                  label: const Text("Take Me Home", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: AppColors.primary,
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              onPressed: () {
                // If there is at least one linked caregiver, open chat with the first one for now
                final caregivers = ApiService.user?['caregiver_ids'];
                if (caregivers != null && caregivers.isNotEmpty) {
                  final firstCaregiverId = caregivers[0] is Map ? caregivers[0]['_id'] : caregivers[0];
                  final caregiverName = caregivers[0] is Map ? caregivers[0]['name'] : 'Caregiver';
                  Navigator.push(context, MaterialPageRoute(builder: (_) => ChatScreen(
                    recipientId: firstCaregiverId,
                    recipientName: caregiverName,
                    isEmergency: true,
                  )));
                } else {
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No caregivers linked.')));
                }
              },
              icon: const Icon(Icons.chat_bubble_outline),
              label: const Text("Chat with Caregiver", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.surface,
                foregroundColor: AppColors.primary,
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        GestureDetector(
      onTap: _raiseEmergency,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20),
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [AppColors.danger, Color(0xFFD32F2F)]),
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: AppColors.danger.withAlpha(80), blurRadius: 15, offset: const Offset(0, 5))
          ],
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: const [
            Icon(Icons.sos, color: Colors.white, size: 36),
            SizedBox(width: 12),
            Text("I'm Lost / Need Help", style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
          ],
        ),
      ),
        ),
        const SizedBox(height: 8),
        _buildVoiceSosToggle(),
      ],
    );
  }

  Widget _buildVoiceSosToggle() {
    final label = !_voiceArmed
        ? 'Or just say "I\'m lost"'
        : (_hearing ? 'Listening - say "I\'m lost"' : 'Listening starts again in a moment');
    return Row(
      children: [
        Icon(_hearing ? Icons.mic : Icons.mic_none,
            size: 20, color: _hearing ? AppColors.danger : AppColors.textSecondary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(label,
              style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: _hearing ? AppColors.danger : AppColors.textSecondary)),
        ),
        Switch(
          value: _voiceArmed,
          onChanged: (v) => _setVoiceArmed(v),
        ),
      ],
    );
  }

  Widget _buildRtmpBanner() {
    final host = Uri.parse(ApiService.baseUrl).host;
    final userId = ApiService.user?['_id'] ?? 'unknown';
    final rtmpUrl = 'rtmp://$host/live/$userId';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.primary,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(color: AppColors.primary.withValues(alpha: 0.3), blurRadius: 10, offset: const Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.2), shape: BoxShape.circle),
                child: const Icon(Icons.videocam_outlined, color: Colors.white, size: 24),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Text('AI Camera RTMP Link', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Text('Configure your camera (e.g. OBS/GoPro) to stream to:', style: TextStyle(color: Colors.white70, fontSize: 13)),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.2),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(rtmpUrl, style: const TextStyle(color: Colors.white, fontSize: 13, fontFamily: 'monospace')),
                ),
                GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: rtmpUrl));
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('RTMP Link Copied')));
                  },
                  child: const Icon(Icons.copy, color: Colors.white, size: 18),
                )
              ],
            ),
          )
        ],
      ),
    );
  }

}
