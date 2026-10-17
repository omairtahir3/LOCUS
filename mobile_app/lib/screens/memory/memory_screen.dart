import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher_string.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/selected_user_service.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:speech_to_text/speech_to_text.dart';

class MemoryScreen extends StatefulWidget {
  final String? targetUserId;
  /// Whether this screen is the one the user is actually looking at.
  ///
  /// It has to be told, because the bottom nav hosts these in an IndexedStack,
  /// which keeps every tab mounted and wraps the hidden ones in
  /// Visibility(maintainAnimation: true) -- so a timer in here keeps firing
  /// while the user is on Home, and nothing inherited says otherwise. Declared
  /// as a property rather than set through the GlobalKey so the value is right
  /// on the first build too.
  ///
  /// Defaults to true for the case where this screen is pushed as its own route
  /// from the More menu, where it is visible for as long as it exists.
  final bool isVisible;
  const MemoryScreen({super.key, this.targetUserId, this.isVisible = true});

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> with WidgetsBindingObserver {
  final _searchCtrl = TextEditingController();
  String _activeFilter = 'All';
  final _filters = ['All', 'Medicine', 'People', 'Activity', 'Objects'];
  
  static const Map<String, IconData> _filterIcons = {
    'All': Icons.grid_view_rounded,
    'Medicine': Icons.medication_outlined,
    'People': Icons.people_outline,
    'Activity': Icons.directions_run_outlined,
    'Objects': Icons.inventory_2_outlined,
  };
  
  List<dynamic> _events = [];
  bool _isLoading = false;
  /// One day at a time, like the Activity Feed. null means "all days", the
  /// old behaviour of showing the most recent memories regardless of date.
  DateTime? _date = DateTime.now();

  bool get _isToday => _date != null && DateUtils.isSameDay(_date!, DateTime.now());

  // Asking, as opposed to filtering. Typing still narrows the rows already
  // loaded, which is unchanged. Submitting the field or speaking sends the
  // question to the agent, which searches the whole record instead.
  final _speech = SpeechToText();
  bool _speechReady = false;
  bool _listening = false;
  /// Why the microphone is not available, in words meant for the wearer.
  ///
  /// This used to be nowhere. initialize() returning false and every runtime
  /// error were both discarded, and the button was hidden -- so "it does not
  /// work" was the whole of the available information, on the phone and in
  /// the logs alike.
  String? _speechProblem;
  /// The best transcript so far, and whether it has already been sent.
  ///
  /// Android needs partial results switched on to transcribe at all, so
  /// finality is decided here rather than by the recognizer: these two keep
  /// the original promise that the agent is asked once, with a finished
  /// sentence, never with half of one.
  String _heard = '';
  bool _heardSent = false;
  /// Diagnostics for a session that ends with no words at all.
  ///
  /// error_no_match cannot distinguish "the microphone delivered silence" from
  /// "speech arrived and was not matched", and those need opposite fixes. The
  /// sound level says which: flat at zero means no audio is reaching the app,
  /// which on Android is usually the system-wide microphone toggle muting
  /// every app while still reporting the permission as granted. The stopwatch
  /// says whether the session lasted its twelve seconds or ended at once.
  double _loudest = 0;
  Stopwatch? _listenWatch;
  bool _asking = false;
  Map<String, dynamic>? _answer;
  bool _answerImageBroken = false;

  // A memory can appear while the page is open: the wearer puts something down
  // in the next room and the sighting is logged seconds later. The web polls
  // every 15 s for this, and the phone did not, so the list went stale until the
  // tab was tapped again. Same interval, because the query itself measures 6-8 ms
  // and the images are immutable-cached, so a poll costs a request and little else.
  //
  // What makes it affordable on a phone is the gate below, not a longer interval:
  // nothing polls unless this is the visible tab, the app is in the foreground,
  // AND the day being viewed is today. A past day cannot gain new memories.
  static const _refreshInterval = Duration(seconds: 15);
  Timer? _refreshTimer;
  bool _foreground = true;

  bool get _shouldPoll => widget.isVisible && _foreground && _isToday;

  void _syncRefreshTimer() {
    if (_shouldPoll) {
      _refreshTimer ??= Timer.periodic(_refreshInterval, (_) {
        // Re-checked on every tick: _date can change under the timer.
        if (_shouldPoll) _loadEvents(quiet: true);
      });
    } else {
      _refreshTimer?.cancel();
      _refreshTimer = null;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final wasForeground = _foreground;
    _foreground = state == AppLifecycleState.resumed;
    _syncRefreshTimer();
    // Coming back to the app is exactly when the list is most likely stale, and
    // waiting out a whole interval to find out is the wrong way round. This is
    // the counterpart of the web refreshing on visibilitychange.
    if (!wasForeground && _foreground && _shouldPoll) _loadEvents(quiet: true);
    // Coming back from Android settings with the microphone now allowed is
    // precisely when to try again, and nothing else would ever ask. See
    // _initSpeech: this screen is never remounted.
    if (!wasForeground && _foreground && !_speechReady) _initSpeech();
  }

  @override
  void didUpdateWidget(MemoryScreen old) {
    super.didUpdateWidget(old);
    // The parent already calls reload() when this tab is tapped, so becoming
    // visible needs no fetch here, only the timer started or stopped.
    if (old.isVisible != widget.isVisible) _syncRefreshTimer();
    if (!old.isVisible && widget.isVisible) {
      // Coming forward is the moment to make sure the microphone is ready, so
      // the first tap can listen instead of spending itself on start-up.
      // Permission may have been granted elsewhere since this screen was built
      // -- the SOS voice toggle asks for the same one -- and without this the
      // person would tap once for nothing and again to be heard.
      //
      // askNow is deliberately not set: being asked for a microphone because
      // you changed tabs is startling. The tap still asks when it must.
      if (!_speechReady) _initSpeech();
      // And the home screen's listener may have been holding the recogniser
      // until a moment ago, so a stale session here is worth clearing.
      if (_listening) {
        _speech.cancel();
        setState(() => _listening = false);
      }
    }
  }

  /// Turn an Android recognizer error code into something a person can act on.
  static String _explainSpeech(String code) {
    switch (code) {
      case 'error_insufficient_permissions':
        return 'Microphone access for LOCUS is turned off in Android settings.';
      case 'error_network':
      case 'error_network_timeout':
        return 'Speech recognition could not reach the network.';
      case 'error_busy':
        return 'Another app is using the microphone.';
      default:
        return 'Speech to text stopped: $code';
    }
  }

  /// Get the microphone ready, and be able to say why when it is not.
  ///
  /// Callable more than once, which is the fix for what actually went wrong.
  /// This screen lives in the bottom nav's IndexedStack, so it mounts once per
  /// app launch and initState never runs a second time. The first attempt
  /// decided _speechReady for the whole life of the process -- so allowing the
  /// microphone afterwards, in the prompt or in Android settings, changed
  /// nothing at all, the button stayed hidden, and the reason had already been
  /// thrown away. It is now retried whenever the app returns to the foreground
  /// and whenever the wearer taps the button.
  Future<void> _initSpeech({bool askNow = false}) async {
    if (_speechReady) return;
    String? problem;
    bool ok = false;
    try {
      // Asked for explicitly, the way step counting asks for its sensor,
      // rather than left to the plugin's implicit request -- initialize()
      // returns false while that prompt is still on screen, and false was
      // being cached as "this phone cannot listen".
      var status = await Permission.microphone.status;
      // Only prompt when the wearer has actually asked to talk. Mounting a tab
      // is not a request to be asked for the microphone.
      if (!status.isGranted && askNow && !status.isPermanentlyDenied) {
        status = await Permission.microphone.request();
      }
      if (!status.isGranted) {
        problem = status.isPermanentlyDenied
            ? 'Microphone access for LOCUS is turned off in Android settings.'
            : 'LOCUS needs permission to use the microphone.';
      } else {
        ok = await _speech.initialize(
          // The Android side's own account: whether onBeginningOfSpeech ever
          // fires, and the RMS the recognizer itself measured. Everything this
          // screen can see says the audio is fine and Google still returns
          // no_match, so the next thing to read is the recognizer's own log.
          debugLogging: true,
          onError: (e) {
            debugPrint('[speech] ${e.errorMsg} (permanent: ${e.permanent}) '
                'after ${_listenWatch?.elapsedMilliseconds ?? 0}ms, '
                'loudest ${_loudest.toStringAsFixed(1)}, '
                'heard "$_heard"');
            if (!mounted) return;
            // A no-match is not a fault, whatever permanent says.
            //
            // Android reports error_no_match with permanent: true, so it was
            // being filed as a standing problem with speech on this phone. It
            // is the ordinary outcome of saying nothing into the microphone --
            // or of speaking a language the recognizer is not set to listen
            // for. Either way the button must keep working.
            final ordinary = e.errorMsg == 'error_no_match' ||
                e.errorMsg == 'error_speech_timeout';
            setState(() {
              _listening = false;
              if (e.permanent && !ordinary) {
                _speechProblem = _explainSpeech(e.errorMsg);
              }
            });
            if (ordinary && _heard.trim().isEmpty) {
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                content: Text('Did not catch that. Try again, a little closer.'),
                duration: Duration(seconds: 3),
              ));
            }
          },
          onStatus: (st) {
            debugPrint('[speech] status $st at '
                '${_listenWatch?.elapsedMilliseconds ?? 0}ms, '
                'loudest ${_loudest.toStringAsFixed(1)}');
            if (!mounted || st == 'listening') return;
            // The session has ended. If a transcript arrived but was never
            // flagged final -- which Android does -- this is where it gets
            // sent, and _heardSent stops it being sent twice.
            setState(() => _listening = false);
            _sendHeard();
          },
        );
        if (!ok) {
          problem = 'This phone has no speech recogniser installed. On most '
              'Android phones that is Speech Services by Google, which can be '
              'disabled or missing.';
        } else {
          // Which language it will actually listen for. A recognizer set to
          // one language and a wearer speaking another returns error_no_match
          // and nothing else, which is indistinguishable from silence.
          try {
            final sys = await _speech.systemLocale();
            debugPrint('[speech] ready, listening in ${sys?.localeId} '
                '(${sys?.name})');
          } catch (_) {
            // Diagnostics only; never worth failing initialisation over.
          }
        }
      }
    } catch (e) {
      // MissingPluginException where the platform channel is absent, which is
      // every widget test and any platform the plugin does not cover. Without
      // this the whole screen fails to settle instead of just losing its mic.
      problem = 'Speech to text is not available on this device.';
      debugPrint('[speech] unavailable: $e');
    }
    if (!mounted) return;
    setState(() {
      _speechReady = ok;
      _speechProblem = ok ? null : problem;
    });
  }

  Future<void> _listen() async {
    // Press again to stop. This used to return here and do nothing, so the
    // only way to end a session was to wait for the recogniser to time out.
    if (_listening) {
      await _speech.stop();
      if (mounted) setState(() => _listening = false);
      // Whatever was heard before stopping is still an answer worth sending.
      _sendHeard();
      return;
    }
    if (!_speechReady) {
      await _initSpeech(askNow: true);
      if (!_speechReady) {
        if (!mounted) return;
        final perm = await Permission.microphone.status;
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(_speechProblem ?? 'Speech to text is unavailable.'),
          duration: const Duration(seconds: 6),
          // Only where tapping Allow is no longer offered. Android stops
          // showing the prompt after two refusals, and from then on the only
          // way back is the settings page.
          action: perm.isPermanentlyDenied
              ? SnackBarAction(label: 'Settings', onPressed: openAppSettings)
              : null,
        ));
        return;
      }
    }
    if (!mounted) return;
    _heard = '';
    _heardSent = false;
    _loudest = 0;
    _listenWatch = Stopwatch()..start();
    setState(() => _listening = true);
    await _speech.listen(
      onResult: (r) {
        debugPrint('[speech] result "${r.recognizedWords}" '
            'final=${r.finalResult}');
        // Keep the best transcript so far; decide when it is finished below.
        if (r.recognizedWords.isNotEmpty) _heard = r.recognizedWords;
        if (r.finalResult) _sendHeard();
      },
      // The microphone's own level. Nothing is shown from it; it is here to
      // tell silence apart from unmatched speech.
      onSoundLevelChange: (level) {
        if (level > _loudest) _loudest = level;
      },
      listenOptions: SpeechListenOptions(
        // ponytail: ON, against the comment that used to be here.
        //
        // This was false, to keep a half-recognised question from reaching the
        // agent. But on Android the flag does not mean "only the final
        // result" -- with partial results off, its SpeechRecognizer commonly
        // returns ERROR_NO_MATCH and no transcript whatsoever, which is
        // exactly what a Pixel 6 did here. The guarantee it was protecting is
        // now kept in _sendHeard instead, where it does not depend on an
        // Android flag behaving as its name suggests.
        partialResults: true,
        // A no-match no longer has to end everything; the words already heard
        // are still worth sending.
        cancelOnError: false,
        // Both belong here rather than as arguments to listen(), where they
        // are deprecated.
        //
        // pauseFor was 3 s, and that was the whole bug. It is described as the
        // silence after which listening stops, but the plugin resets its timer
        // on incoming RESULTS, not on sound level -- so a session that has not
        // yet received a partial is cut off at exactly pauseFor however loudly
        // the wearer is speaking. Measured on a Pixel 6: notListening at
        // 3086ms with the microphone at full scale, then no_match on the
        // truncated audio. And because no_match yields no result, the timer
        // was never reset, so every attempt failed at the same three seconds.
        //
        // 8 s was tried and made no difference: the session then ran its full
        // eight seconds, with audio at 10.0, and Google still returned
        // no_match. So the window was never what was wrong, and 4 s is kept
        // for what pauseFor actually governs once speech onset is detected --
        // the wait AFTER the wearer stops talking, since the plugin cancels
        // this timer on onBeginningOfSpeech and restarts it on
        // onEndOfSpeech. Eight seconds of that is a long silence before the
        // question is sent; three truncated real speech. 30 s caps a question
        // that never ends.
        listenFor: const Duration(seconds: 30),
        pauseFor: const Duration(seconds: 4),
      ),
    );
  }

  /// Ask the agent, exactly once, with whatever was heard.
  ///
  /// Called when the recognizer declares a result final AND when the session
  /// ends, because Android does not reliably do the former -- a question can
  /// be fully transcribed and then simply stop, with the last result never
  /// flagged. _heardSent is what keeps that from asking twice.
  void _sendHeard() {
    final words = _heard.trim();
    if (_heardSent || words.isEmpty) return;
    _heardSent = true;
    _searchCtrl.text = words;
    _askAgent(words);
  }

  Future<void> _askAgent(String question) async {
    final q = question.trim();
    if (q.isEmpty) return;
    setState(() {
      _asking = true;
      _answerImageBroken = false;
    });
    String? selectedId = widget.targetUserId;
    if (selectedId == null && ApiService.userRole == 'caregiver') {
      selectedId = SelectedUserService().selectedUser?['_id']?.toString();
    }
    final res = await ApiService.askMemory(q, userId: selectedId);
    if (!mounted) return;
    setState(() {
      _answer = res;
      _asking = false;
    });
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? DateTime.now(),
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
    );
    if (picked != null) {
      setState(() => _date = picked);
      _syncRefreshTimer();
      _loadEvents();
    }
  }

  void _shiftDay(int days) {
    final base = _date ?? DateTime.now();
    final next = base.add(Duration(days: days));
    if (next.isAfter(DateTime.now())) return;
    setState(() => _date = next);
    _syncRefreshTimer();
    _loadEvents();
  }

  @override
  void initState() {
    super.initState();
    SelectedUserService().addListener(_onSelectedUserChanged);
    WidgetsBinding.instance.addObserver(this);
    _loadEvents();
    _initSpeech();
    _syncRefreshTimer();
  }

  void _onSelectedUserChanged() {
    if (mounted) _loadEvents();
  }

  @override
  void dispose() {
    SelectedUserService().removeListener(_onSelectedUserChanged);
    WidgetsBinding.instance.removeObserver(this);
    // A Timer outlives its State unless cancelled, and would keep calling
    // setState on a disposed widget.
    _refreshTimer?.cancel();
    _searchCtrl.dispose();
    // Leaving a session running holds the microphone after the screen is gone.
    if (_listening) _speech.cancel();
    super.dispose();
  }

  void reload() {
    if (mounted) _loadEvents();
  }

  Future<void> _loadEvents({bool quiet = false}) async {
    // A background poll must not show the loading state: the list would blink
    // away under whoever is reading it every 15 seconds.
    if (!quiet) setState(() => _isLoading = true);
    try {
      String? selectedId = widget.targetUserId;
      if (selectedId == null && ApiService.userRole == 'caregiver') {
        selectedId = SelectedUserService().selectedUser?['_id']?.toString();
      }
      // A chosen day returns EVERY memory from it. The old limit of 50 hid
      // whole afternoons, which is the opposite of what a memory aid is for.
      final res = await ApiService.getMemorySearchEvents(
        userId: selectedId,
        date: _date == null ? null : DateFormat('yyyy-MM-dd').format(_date!),
      );
      setState(() => _events = res);
    } catch (e) {
      debugPrint('Error loading memories: $e');
    } finally {
      if (mounted && !quiet) setState(() => _isLoading = false);
    }
  }

  Future<void> _toggleFlag(String eventId, bool currentFlag) async {
    final success = await ApiService.toggleEventFlag(eventId, !currentFlag);
    if (success) {
      _loadEvents();
    } else {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to toggle flag')),
        );
      }
    }
  }

  /// The agent's answer, above the filters. It states a TIME and shows a
  /// PHOTOGRAPH and deliberately names no place: nothing in the record says
  /// which room it was, so the picture is the answer to "where".
  Widget _buildAnswerCard() {
    final a = _answer!;
    final text = a['answer']?.toString() ?? '';
    // The backend withholds an id once the frame is past its retention window,
    // so a null here means the picture is genuinely gone rather than slow. The
    // flag below covers the race where it goes between answer and fetch.
    final kf = _answerImageBroken ? null : a['keyframe_id']?.toString();
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.primaryLight,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (kf != null && kf.isNotEmpty) ...[
            GestureDetector(
              onTap: () => _showImagePreview(ApiService.keyframeImageUrl(kf), text),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.network(
                  // The 240px thumbnail, not the 125 kB frame: this is a phone.
                  ApiService.keyframeImageUrl(kf, width: 240),
                  headers: ApiService.imageHeaders,
                  width: 72,
                  height: 72,
                  fit: BoxFit.cover,
                  // A memory routinely outlives its picture under the keyframe
                  // retention window, so a gone frame is normal, not an error.
                  // Nothing is drawn in its place: a grey box with a crossed-out
                  // icon still reads as a photo that failed, and the answer has
                  // already been written without reference to one.
                  errorBuilder: (_, __, ___) {
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted && !_answerImageBroken) {
                        setState(() => _answerImageBroken = true);
                      }
                    });
                    return const SizedBox.shrink();
                  },
                ),
              ),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(text,
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w600, height: 1.4)),
                if (kf != null && kf.isNotEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text('Tap the photo to see the spot.',
                        style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  ),
              ],
            ),
          ),
          IconButton(
            onPressed: () => setState(() => _answer = null),
            tooltip: 'Dismiss',
            visualDensity: VisualDensity.compact,
            icon: const Icon(Icons.close, size: 16),
          ),
        ],
      ),
    );
  }

  void _showImagePreview(String imageUrl, String title) {
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.black87,
        insetPadding: const EdgeInsets.all(16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, color: Colors.white, size: 22),
                    onPressed: () => Navigator.pop(ctx),
                  ),
                ],
              ),
            ),
            ClipRRect(
              borderRadius: const BorderRadius.vertical(bottom: Radius.circular(16)),
              child: Image.network(
                imageUrl,
                headers: ApiService.imageHeaders,
                fit: BoxFit.contain,
                errorBuilder: (_, __, ___) => Container(
                  padding: const EdgeInsets.all(32),
                  color: Colors.grey.shade900,
                  child: const Center(
                    child: Text('Failed to load image', style: TextStyle(color: Colors.white70)),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<_MemoryItem> _getFormattedMemories() {
    return _events.map((ev) {
      try {
        final dt = DateTime.parse(ev['timestamp']);
        final localDt = dt.toLocal();
        final timeLabel = DateFormat('h:mm a').format(localDt);
        final now = DateTime.now();
        
        String groupLabel = 'Earlier';
        
        if (_date != null) {
          // Viewing one day: a single "Today" heading is just a wall of cards,
          // so split it into the parts of the day instead.
          final h = localDt.hour;
          groupLabel = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
        } else if (now.year == localDt.year && now.month == localDt.month && now.day == localDt.day) {
          groupLabel = 'Today';
        } else if (now.year == localDt.year && now.month == localDt.month && now.day - 1 == localDt.day) {
          groupLabel = 'Yesterday';
        } else {
          groupLabel = DateFormat('MMM d, yyyy').format(localDt);
        }

        if (ev['event_type'] == 'medication_intake' || ev['event_type'] == 'medication') {
          final details = ev['details'];
          return _MemoryItem(
            id: ev['_id'],
            title: 'Took ${(details is Map ? details['medication_name'] : null) ?? 'medication'}',
            time: timeLabel,
            icon: Icons.medication,
            color: AppColors.success,
            group: groupLabel,
            category: 'Medicine',
            imageUrl: ev['keyframe_id'] != null ? ApiService.medicationFrameImageUrl(ev['keyframe_id']) : null,
            isFlagged: ev['is_flagged'] == true,
            location: ev['location'],
          );
        } else if (ev['event_type'] == 'social_interaction') {
          final pIdData = ev['person_id'];
          final details = ev['details'];
          
          final personName = (pIdData is Map ? pIdData['person_name'] : null) 
              ?? (details is Map ? details['person'] : null) 
              ?? 'Unknown Person';
              
          final personId = pIdData is Map ? pIdData['_id'] : (pIdData is String ? pIdData : null);
          
          return _MemoryItem(
            id: ev['_id'],
            title: 'Saw $personName',
            time: timeLabel,
            icon: Icons.person,
            color: AppColors.primary,
            group: groupLabel,
            category: 'People',
            imageUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id']) : null,
            thumbUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id'], width: 240) : null,
            isFlagged: ev['is_flagged'] == true,
            personId: personId,
            location: ev['location'],
          );
        } else if (ev['event_type'] == 'activity') {
          final details = ev['details'];
          return _MemoryItem(
            id: ev['_id'],
            // sentence, then label, then description: scene and activity
            // sessions all write sentence now, but records written before they
            // did carry only one of the others, and "Activity detected" tells
            // the person nothing at all.
            title: (details is Map
                    ? (details['sentence'] ?? details['label'] ?? details['description'])
                    : null)
                ?? 'Activity detected',
            time: timeLabel,
            icon: Icons.directions_run,
            color: AppColors.warning,
            group: groupLabel,
            category: 'Activity',
            imageUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id']) : null,
            thumbUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id'], width: 240) : null,
            isFlagged: ev['is_flagged'] == true,
            location: ev['location'],
          );
        } else if (ev['event_type'] == 'object') {
          final details = ev['details'];
          List<String> itemNames = [];
          if (details is Map) {
            if (details['item_names'] is List) {
              itemNames = (details['item_names'] as List).map((e) => e.toString()).toList();
            } else if (details['items'] is List) {
              itemNames = (details['items'] as List)
                  .map((e) => (e is Map ? e['name']?.toString() : null) ?? '')
                  .where((s) => s.isNotEmpty)
                  .toList();
            }
          }
          
          final summary = (details is Map ? details['summary'] : null)?.toString();
          // A sighting. "Left" is a departure claim and belongs to the routine
          // monitor's left_behind alert, not to one frame of a resting object.
          final titleText = itemNames.isNotEmpty
              ? 'Spotted ${itemNames.take(3).join(', ')}${itemNames.length > 3 ? ' +${itemNames.length - 3} more' : ''}'
              : (summary ?? 'Items detected');

          return _MemoryItem(
            id: ev['_id'],
            title: titleText,
            time: timeLabel,
            icon: Icons.inventory_2_outlined,
            color: const Color(0xFF6366F1),
            group: groupLabel,
            category: 'Objects',
            imageUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id']) : null,
            thumbUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id'], width: 240) : null,
            isFlagged: ev['is_flagged'] == true,
            location: ev['location'],
            itemNames: itemNames,
          );
        }
        return null;
      } catch (e, st) {
        debugPrint('Error parsing memory event: $e\n$st');
        return _MemoryItem(
          id: ev['_id']?.toString() ?? 'error',
          title: 'Parse Error: $e',
          time: '-',
          icon: Icons.error,
          color: Colors.red,
          group: 'Errors',
          category: 'All',
        );
      }
    }).where((item) => item != null).cast<_MemoryItem>().toList();
  }

  @override
  Widget build(BuildContext context) {
    final allMemories = _getFormattedMemories();
    final objectMemories = allMemories.where((m) => m.category == 'Objects').toList();
    
    // Apply filter
    final filtered = _activeFilter == 'All' 
        ? allMemories 
        : allMemories.where((m) => m.category == _activeFilter).toList();
        
    // Apply search
    final query = _searchCtrl.text.toLowerCase().trim();
    final searched = query.isNotEmpty 
        ? filtered.where((m) {
            if (m.title.toLowerCase().contains(query)) return true;
            if (m.itemNames != null && m.itemNames!.any((name) => name.toLowerCase().contains(query))) return true;
            return false;
          }).toList()
        : filtered;

    return Column(
      children: [
        // Search bar
        Container(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
          color: AppColors.surface,
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Memory Search', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  if (ApiService.userRole == 'caregiver')
                    AnimatedBuilder(
                      animation: SelectedUserService(),
                      builder: (context, child) {
                        final service = SelectedUserService();
                        if (service.monitoringUsers.isEmpty) return const SizedBox.shrink();
                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 0),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: Colors.grey.shade300),
                          ),
                          child: DropdownButtonHideUnderline(
                            child: DropdownButton<String>(
                              isDense: true,
                              value: service.selectedUser?['_id'],
                              icon: const Icon(Icons.arrow_drop_down, color: Colors.black54, size: 18),
                              style: const TextStyle(color: Colors.black87, fontWeight: FontWeight.bold, fontSize: 12),
                              onChanged: (String? newValue) {
                                if (newValue != null) service.setSelectedUser(newValue);
                              },
                              items: service.monitoringUsers.map<DropdownMenuItem<String>>((dynamic u) {
                                return DropdownMenuItem<String>(
                                  value: u['_id'],
                                  child: Text(u['name'] ?? 'Unknown', style: const TextStyle(fontSize: 12)),
                                );
                              }).toList(),
                            ),
                          ),
                        );
                      },
                    ),
                ],
              ),
              const SizedBox(height: 12),
              // Day selector, matching the Activity Feed.
              Row(
                children: [
                  IconButton(
                    onPressed: () => _shiftDay(-1),
                    icon: const Icon(Icons.chevron_left),
                    tooltip: 'Previous day',
                    visualDensity: VisualDensity.compact,
                  ),
                  Expanded(
                    child: InkWell(
                      onTap: _pickDate,
                      borderRadius: BorderRadius.circular(10),
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 10),
                        decoration: BoxDecoration(
                          color: AppColors.surface,
                          border: Border.all(color: AppColors.border),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.calendar_today_outlined, size: 15, color: AppColors.textMuted),
                            const SizedBox(width: 7),
                            Flexible(
                              child: Text(
                                _date == null
                                    ? 'All days'
                                    : _isToday ? 'Today' : DateFormat('EEE d MMM').format(_date!),
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: (_date == null || _isToday) ? null : () => _shiftDay(1),
                    icon: const Icon(Icons.chevron_right),
                    tooltip: 'Next day',
                    visualDensity: VisualDensity.compact,
                  ),
                  TextButton(
                    onPressed: () {
                      setState(() => _date = _date == null ? DateTime.now() : null);
                      _syncRefreshTimer();
                      _loadEvents();
                    },
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(0, 36),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Text(_date == null ? 'By day' : 'All days',
                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _searchCtrl,
                      onChanged: (_) => setState(() {}),
                      textInputAction: TextInputAction.search,
                      onSubmitted: _askAgent,
                      decoration: InputDecoration(
                        hintText: 'Search, or ask where you left something...',
                        prefixIcon: const Icon(Icons.search, size: 20),
                        contentPadding: const EdgeInsets.symmetric(vertical: 10),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
                  ),
                  // Shown even when the microphone is not ready, greyed out.
                  //
                  // It used to be hidden, so that it was never a button that
                  // did nothing. But that also meant a phone which could not
                  // listen gave no sign of why and offered no way to fix it,
                  // and a microphone allowed after launch looked identical to
                  // one refused. Greyed out it still does something: it asks,
                  // and failing that it says what is wrong.
                  const SizedBox(width: 8),
                  Container(
                    decoration: BoxDecoration(
                      color: _listening
                          ? AppColors.danger
                          : (_speechReady ? AppColors.primary : AppColors.textMuted),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: IconButton(
                      onPressed: _asking ? null : _listen,
                      tooltip: _listening
                          ? 'Listening - tap to stop'
                          : (_speechReady ? 'Ask out loud' : 'Allow the microphone'),
                      icon: Icon(_listening ? Icons.mic : Icons.mic_none,
                          color: Colors.white, size: 20),
                    ),
                  ),
                ],
              ),
              if (_asking)
                const Padding(
                  padding: EdgeInsets.only(top: 12),
                  child: Text('Looking through your memories...',
                      style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                ),
              if (_answer != null && !_asking) _buildAnswerCard(),
              const SizedBox(height: 10),
              // Filter chips
              SizedBox(
                height: 36,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: _filters.map((f) {
                    final count = f == 'All' ? allMemories.length : allMemories.where((m) => m.category == f).length;
                    final isSelected = _activeFilter == f;
                    final icon = _filterIcons[f];
                    return Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        showCheckmark: false,
                        avatar: icon != null 
                            ? Icon(icon, size: 14, color: isSelected ? Colors.white : AppColors.textSecondary)
                            : null,
                        label: Text('$f ($count)', style: TextStyle(
                          fontSize: 11, 
                          fontWeight: FontWeight.w600,
                          color: isSelected ? Colors.white : AppColors.textSecondary,
                        )),
                        selected: isSelected,
                        onSelected: (_) => setState(() => _activeFilter = f),
                        selectedColor: f == 'Objects' ? const Color(0xFF4F46E5) : AppColors.primary,
                        backgroundColor: AppColors.borderLight,
                        side: BorderSide.none,
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        visualDensity: VisualDensity.compact,
                      ),
                    );
                  }).toList(),
                ),
              ),
            ],
          ),
        ),

        // Results
        Expanded(
          child: _isLoading 
            ? const Center(child: CircularProgressIndicator())
            : RefreshIndicator(
                onRefresh: _loadEvents,
                child: searched.isEmpty 
                  ? SingleChildScrollView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      child: Container(
                        height: MediaQuery.of(context).size.height * 0.5,
                        alignment: Alignment.center,
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.search_off, size: 56, color: AppColors.textMuted),
                            const SizedBox(height: 12),
                            Text(query.isNotEmpty ? 'No results found' : 'No memories yet', 
                                 style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 4),
                            Text('When the AI camera detects items or events, they will appear here.',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                          ],
                        ),
                      ),
                    )
                  : _buildMemoriesList(searched, objectMemories, query),
              ),
        ),
      ],
    );
  }

  Widget _buildObjectsCarousel(List<_MemoryItem> objectMemories) {
    if (objectMemories.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF6366F1).withAlpha(15),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF6366F1).withAlpha(40)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: const [
                  Icon(Icons.inventory_2_outlined, color: Color(0xFF4F46E5), size: 18),
                  SizedBox(width: 6),
                  Text('Detected Objects & Items', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: Color(0xFF312E81))),
                ],
              ),
              GestureDetector(
                onTap: () => setState(() => _activeFilter = 'Objects'),
                child: const Text('View All', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Color(0xFF4F46E5))),
              ),
            ],
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 110,
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              itemCount: objectMemories.length,
              itemBuilder: (ctx, i) {
                final obj = objectMemories[i];
                final displayName = (obj.itemNames != null && obj.itemNames!.isNotEmpty)
                    ? obj.itemNames!.first
                    : obj.title;
                return GestureDetector(
                  onTap: () {
                    if (obj.imageUrl != null) {
                      _showImagePreview(obj.imageUrl!, obj.title);
                    }
                  },
                  child: Container(
                    width: 120,
                    margin: const EdgeInsets.only(right: 10),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.black.withAlpha(15)),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withAlpha(8),
                          blurRadius: 4,
                          offset: const Offset(0, 2),
                        ),
                      ],
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: ClipRRect(
                            borderRadius: const BorderRadius.vertical(top: Radius.circular(11)),
                            child: obj.imageUrl != null
                                ? Image.network(
                                    obj.thumbUrl ?? obj.imageUrl!,
                                    headers: ApiService.imageHeaders,
                                    width: double.infinity,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, __, ___) => Container(
                                      color: const Color(0xFF6366F1).withAlpha(20),
                                      child: const Center(child: Icon(Icons.inventory_2, color: Color(0xFF6366F1), size: 24)),
                                    ),
                                  )
                                : Container(
                                    color: const Color(0xFF6366F1).withAlpha(20),
                                    child: const Center(child: Icon(Icons.inventory_2, color: Color(0xFF6366F1), size: 24)),
                                  ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                displayName,
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              Text(
                                obj.time,
                                style: TextStyle(color: AppColors.textSecondary, fontSize: 9),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMemoriesList(List<_MemoryItem> memories, List<_MemoryItem> objectMemories, String query) {
    String? lastGroup;
    final showObjectsCarousel = _activeFilter == 'All' && query.isEmpty && objectMemories.isNotEmpty;
    
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      itemCount: memories.length + (showObjectsCarousel ? 1 : 0),
      itemBuilder: (ctx, idx) {
        if (showObjectsCarousel && idx == 0) {
          return _buildObjectsCarousel(objectMemories);
        }

        final i = showObjectsCarousel ? idx - 1 : idx;
        final m = memories[i];
        final showHeader = m.group != lastGroup;
        lastGroup = m.group;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (showHeader) Padding(
              padding: EdgeInsets.only(top: i == 0 && !showObjectsCarousel ? 0 : 16, bottom: 8),
              child: Text(m.group, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700,
                  color: AppColors.textMuted, letterSpacing: 0.5)),
            ),
            Card(
              margin: const EdgeInsets.only(bottom: 8),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(
                  color: m.isFlagged ? AppColors.primary : Colors.transparent,
                  width: m.isFlagged ? 2 : 0,
                ),
              ),
              child: ListTile(
                onTap: () {
                  if (m.personId != null) {
                    Navigator.pushNamed(context, '/past-interactions', arguments: m.personId);
                  } else if (m.imageUrl != null) {
                    _showImagePreview(m.imageUrl!, m.title);
                  }
                },
                leading: GestureDetector(
                  onTap: m.imageUrl != null ? () => _showImagePreview(m.imageUrl!, m.title) : null,
                  child: Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(color: m.color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
                    child: m.imageUrl != null 
                      ? ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.network(
                            m.thumbUrl ?? m.imageUrl!,
                            headers: ApiService.imageHeaders,
                            fit: BoxFit.cover,
                            errorBuilder: (c, e, s) => Icon(m.icon, color: m.color, size: 20),
                          ),
                        )
                      : Icon(m.icon, color: m.color, size: 20),
                  ),
                ),
                title: Text(
                  m.title, 
                  style: TextStyle(
                    fontWeight: FontWeight.w600, 
                    fontSize: 14,
                    color: m.personId != null ? AppColors.primary : AppColors.textPrimary,
                    decoration: m.personId != null ? TextDecoration.underline : TextDecoration.none,
                  ),
                ),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (m.itemNames != null && m.itemNames!.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Wrap(
                        spacing: 4,
                        runSpacing: 4,
                        children: m.itemNames!.take(4).map((name) => Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                          decoration: BoxDecoration(
                            color: const Color(0xFF6366F1).withAlpha(20),
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: const Color(0xFF6366F1).withAlpha(50), width: 0.5),
                          ),
                          child: Text(
                            name,
                            style: const TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFF4F46E5),
                            ),
                          ),
                        )).toList(),
                      ),
                    ],
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        Text(m.time, style: TextStyle(color: AppColors.textSecondary, fontSize: 11)),
                        if (m.location != null) ...[
                          const SizedBox(width: 6),
                          Tooltip(
                            message: 'Lat: ${m.location!['lat']}, Lng: ${m.location!['lng']}',
                            triggerMode: TooltipTriggerMode.tap,
                            child: GestureDetector(
                              onTap: () {
                                launchUrlString('https://www.google.com/maps/search/?api=1&query=${m.location!['lat']},${m.location!['lng']}');
                              },
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFEEECF9),
                                  borderRadius: BorderRadius.circular(12),
                                ),
                                child: Row(
                                  children: const [
                                    Icon(Icons.location_on, size: 10, color: Color(0xFF4F46E5)),
                                    SizedBox(width: 2),
                                    Text('Location Logged', style: TextStyle(
                                      fontSize: 9, 
                                      fontWeight: FontWeight.w700, 
                                      color: Color(0xFF4F46E5)
                                    )),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
                trailing: IconButton(
                  icon: Icon(Icons.push_pin, size: 20, color: m.isFlagged ? AppColors.primary : AppColors.border),
                  onPressed: () => _toggleFlag(m.id, m.isFlagged),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _MemoryItem {
  final String id, title, time, group, category;
  final IconData icon;
  final Color color;
  final String? imageUrl;
  /// The 240px version, for the inline picture. Separate from imageUrl because
  /// the same value fed BOTH the list thumbnail and the full-size preview, so
  /// a day of memories pulled a 125 kB frame each over mobile data to render
  /// them 56px wide. The preview still uses imageUrl.
  final String? thumbUrl;
  final bool isFlagged;
  final String? personId;
  final Map<String, dynamic>? location;
  final List<String>? itemNames;
  
  _MemoryItem({
    required this.id, required this.title, required this.time, 
    required this.icon, required this.color, required this.group,
    required this.category, this.imageUrl, this.thumbUrl, this.isFlagged = false,
    this.personId, this.location, this.itemNames,
  });
}
