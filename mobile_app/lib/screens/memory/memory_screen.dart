import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher_string.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/selected_user_service.dart';
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
  bool _asking = false;
  Map<String, dynamic>? _answer;

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
  }

  @override
  void didUpdateWidget(MemoryScreen old) {
    super.didUpdateWidget(old);
    // The parent already calls reload() when this tab is tapped, so becoming
    // visible needs no fetch here, only the timer started or stopped.
    if (old.isVisible != widget.isVisible) _syncRefreshTimer();
  }

  Future<void> _initSpeech() async {
    // Returns false where there is no recognizer or the microphone is refused.
    // The button is hidden in that case rather than shown and failing.
    bool ok = false;
    try {
      ok = await _speech.initialize(
        onError: (_) { if (mounted) setState(() => _listening = false); },
        onStatus: (st) {
          if (mounted && st != 'listening') setState(() => _listening = false);
        },
      );
    } catch (e) {
      // MissingPluginException where the platform channel is absent, which is
      // every widget test and any platform the plugin does not cover. Without
      // this the whole screen fails to settle instead of just losing its mic.
      debugPrint('speech unavailable: $e');
    }
    if (mounted) setState(() => _speechReady = ok);
  }

  Future<void> _listen() async {
    if (!_speechReady || _listening) return;
    setState(() => _listening = true);
    await _speech.listen(
      onResult: (r) {
        if (!r.finalResult) return;
        _searchCtrl.text = r.recognizedWords;
        _askAgent(r.recognizedWords);
      },
      listenOptions: SpeechListenOptions(
        // Only the final transcript: a half-recognised question would be sent
        // to the agent and answered before the sentence was finished.
        partialResults: false,
        cancelOnError: true,
        // Both belong here rather than as arguments to listen(), where they
        // are deprecated. 3 s of silence ends a question; 12 s caps it.
        listenFor: const Duration(seconds: 12),
        pauseFor: const Duration(seconds: 3),
      ),
    );
  }

  Future<void> _askAgent(String question) async {
    final q = question.trim();
    if (q.isEmpty) return;
    setState(() => _asking = true);
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
    final kf = a['keyframe_id']?.toString();
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
                  errorBuilder: (_, __, ___) => Container(
                    width: 72,
                    height: 72,
                    color: AppColors.border,
                    child: const Icon(Icons.image_not_supported_outlined, size: 20),
                  ),
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
                  // Hidden where the platform has no recognizer or the
                  // microphone was refused, so it is never a button that
                  // does nothing. Typing works either way.
                  if (_speechReady) ...[
                    const SizedBox(width: 8),
                    Container(
                      decoration: BoxDecoration(
                        color: _listening ? AppColors.danger : AppColors.primary,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: IconButton(
                        onPressed: _asking ? null : _listen,
                        tooltip: _listening ? 'Listening' : 'Ask out loud',
                        icon: Icon(_listening ? Icons.mic : Icons.mic_none,
                            color: Colors.white, size: 20),
                      ),
                    ),
                  ],
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
