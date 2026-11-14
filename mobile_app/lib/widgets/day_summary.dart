import 'package:flutter/material.dart';

import '../services/api_service.dart';
import '../screens/activity/activity_screen.dart';
import '../screens/caregiver/keyframe_audit_screen.dart';
import '../screens/caregiver/location_map_screen.dart';
import '../screens/items/my_items_screen.dart';
import '../screens/caregiver/medications_screen.dart';
import '../screens/medication/medication_screen.dart';
import '../screens/memory/memory_screen.dart';
import '../screens/routine/routine_screen.dart';
import '../theme/app_theme.dart';
import 'bento.dart';

/// The whole day, on one screen -- the mobile twin of
/// web_app/frontend/src/components/Today/DaySummary.jsx.
///
/// Both web dashboards render that one component: the wearer's /my-dashboard
/// passes `self`, and the caregiver's /dashboard passes `userId` and `canAct`.
/// This is the same arrangement, so the two roles cannot drift apart.
///
/// The bento grid is not part of the pattern at this width. index.css
/// collapses it under 720px:
///
///     .bento { grid-template-columns: 1fr; gap: 14px }
///     .bento-card.is-wide { grid-column: auto }
///
/// so a single column IS the web layout here. What carries across is the head
/// block, the card heads, and the card order.
///
/// Every figure comes from an endpoint that already existed. Nothing is
/// inferred: "left behind" is read from the notifications the backend raises
/// against a real baseline, and an insight the endpoint could not measure
/// stays unmeasured rather than being printed as 0%.
class DaySummary extends StatefulWidget {
  const DaySummary({
    super.key,
    this.userId,
    this.canAct = false,
    this.isElderly = false,
    this.isMonitoredUser = false,
    this.beforeCards = const [],
  });

  /// Whose day. Null means the signed-in account's own.
  final String? userId;

  /// A caregiver's view. Decides the Location card, which the web hides from
  /// a wearer: "nobody needs an app to place them in the room they are
  /// standing in".
  final bool canAct;

  final bool isElderly;
  final bool isMonitoredUser;

  /// Slotted between the head and the first card. The wearer's screen puts
  /// the camera banner and the SOS control here -- the two things that cannot
  /// wait behind a scroll.
  final List<Widget> beforeCards;

  @override
  State<DaySummary> createState() => DaySummaryState();
}

class DaySummaryState extends State<DaySummary> {
  Map<String, dynamic>? _day;
  List<dynamic> _schedule = [];
  List<dynamic> _items = [];     // /user-items/last-seen -- sighted, with a fix
  List<dynamic> _enrolled = [];  // /user-items -- everything enrolled
  List<dynamic> _notices = [];
  List<dynamic> _convos = [];
  Map<String, dynamic>? _fix;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void didUpdateWidget(DaySummary oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A caregiver switching between the people they look after.
    if (oldWidget.userId != widget.userId) load();
  }

  /// Each request falls back to empty on its own. Future.wait rejects on the
  /// first error, which would blank the whole day because one endpoint was
  /// unhappy; the web uses Promise.allSettled for the same reason.
  Future<void> load() async {
    final id = widget.userId;
    try {
      final r = await Future.wait([
        ApiService.getSchedule(userId: id).catchError((_) => <dynamic>[]),
        ApiService.getActivityTimeline(userId: id).catchError((_) => null),
        ApiService.getItemsLastSeen(userId: id).catchError((_) => <dynamic>[]),
        // The enrolment list as well.
        //
        // /user-items/last-seen answers "where is it", and only for items
        // sighted in the last 72 hours WITH a GPS fix. Osaid has two
        // belongings enrolled and no such sighting, so the card showed
        // "Nothing enrolled yet" -- which is not merely unhelpful, it is
        // false. What someone means by "my belongings" is what they enrolled.
        ApiService.getUserItems(userId: id).catchError((_) => <dynamic>[]),
        ApiService.getNotifications(limit: 25).catchError((_) => <dynamic>[]),
        ApiService.getConversations(userId: id).catchError((_) => <dynamic>[]),
        ApiService.getLatestLocation(userId: id).catchError((_) => null),
      ]);
      if (!mounted) return;
      setState(() {
        _schedule = (r[0] as List<dynamic>?) ?? [];
        _day = r[1] as Map<String, dynamic>?;
        _items = (r[2] as List<dynamic>?) ?? [];
        _enrolled = (r[3] as List<dynamic>?) ?? [];
        _notices = (r[4] as List<dynamic>?) ?? [];
        _convos = (r[5] as List<dynamic>?) ?? [];
        _fix = r[6] as Map<String, dynamic>?;
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  // ── The day, derived ───────────────────────────────────────────────────
  // Every value below comes from a payload above. Nothing here is computed
  // from a guess: "left behind" is read from the notifications the backend
  // raises against a real baseline, and an insight the endpoint could not
  // measure stays unmeasured rather than being printed as 0%.

  List<dynamic> get _timeline => (_day?['items'] as List<dynamic>?) ?? [];
  Map<String, dynamic> get _daySummary =>
      (_day?['summary'] as Map<String, dynamic>?) ?? const {};
  List<dynamic> get _insights => (_day?['insights'] as List<dynamic>?) ?? [];
  List<dynamic> get _anomalies => (_day?['anomalies'] as List<dynamic>?) ?? [];

  static const _routineTypes = {
    'routine_medication_gap', 'routine_inactivity', 'routine_camera_off',
    'routine_deviation', 'routine_habitual_item',
  };
  static const _leftBehindTypes = {
    'routine_left_behind', 'routine_item_lost', 'routine_item_lost_escalated',
  };

  List<dynamic> get _unread =>
      _notices.where((n) => n['is_read'] != true).toList();
  List<dynamic> get _emergencyNotices =>
      _unread.where((n) => n['type'] == 'emergency').toList();
  List<dynamic> get _leftBehind =>
      _unread.where((n) => _leftBehindTypes.contains(n['type'])).toList();

  /// The people recognised today, each once. From social timeline entries.
  List<String> get _peopleToday => _timeline
      .where((i) => i['kind'] == 'social')
      .map((i) => (i['title'] ?? '').toString())
      .where((t) => t.isNotEmpty)
      .toSet()
      .toList();

  /// An insight the endpoint could not compute comes back null. If every one
  /// is null there is no baseline at all, and one sentence says more than a
  /// grid of four dashes.
  bool get _hasBaseline => _insights.any((i) => i['value'] != null);

  /// A routine finding reaches this screen twice -- once as a timeline anomaly
  /// and once as the notification raised from it -- so it is keyed on the
  /// title alone, which is what a reader compares.
  List<String> get _findings {
    final out = <String>[];
    final seen = <String>{};
    void add(String? title, [String? detail]) {
      final k = (title ?? '').trim().toLowerCase();
      if (k.isEmpty || seen.contains(k)) return;
      seen.add(k);
      out.add(detail == null || detail.isEmpty ? title! : '$title — $detail');
    }
    for (final a in _anomalies) {
      add(a['title']?.toString(), a['detail']?.toString());
    }
    for (final n in _unread.where((n) => _routineTypes.contains(n['type']))) {
      add(n['title']?.toString());
    }
    return out;
  }

  String? get _lastRoom {
    final rooms = (_daySummary['rooms'] as List<dynamic>?) ?? [];
    return rooms.isEmpty ? null : rooms.last.toString();
  }

  Map<String, dynamic>? get _lastEvent =>
      _timeline.isEmpty ? null : _timeline.last as Map<String, dynamic>;

  Map<String, dynamic>? get _nextDose {
    final pending = _schedule
        .where((x) => x['status'] == 'scheduled' || x['status'] == 'snoozed')
        .toList()
      ..sort((a, b) => (a['scheduled_time'] ?? '')
          .toString()
          .compareTo((b['scheduled_time'] ?? '').toString()));
    return pending.isEmpty ? null : pending.first as Map<String, dynamic>;
  }

  /// ONE sentence, and it is about the DAY -- not about doses. The page this
  /// pattern replaced could only ever say something about medicine.
  String get _statusLine {
    if (_loading) return 'Looking at your day...';
    if (_emergencyNotices.isNotEmpty) return 'An emergency alert is active.';
    if (_unread.isNotEmpty) {
      return _unread.length == 1
          ? '1 alert needs a look.'
          : '${_unread.length} alerts need a look.';
    }
    if (_timeline.isEmpty) return 'Nothing has been recorded yet today.';
    final bits = <String>[];
    final rooms = (_daySummary['rooms'] as List<dynamic>?) ?? [];
    final acts = _daySummary['activities'];
    final social = _daySummary['social'];
    if (rooms.isNotEmpty) {
      bits.add('${rooms.length} ${rooms.length == 1 ? 'room' : 'rooms'}');
    }
    if (acts is num && acts > 0) {
      bits.add('$acts ${acts == 1 ? 'activity' : 'activities'}');
    }
    if (social is num && social > 0) {
      bits.add('$social ${social == 1 ? 'person' : 'people'}');
    }
    return bits.isEmpty ? 'All calm.' : 'All calm — ${bits.join(', ')} so far.';
  }

  static String _titleCase(String v) => v.isEmpty
      ? v
      : v[0].toUpperCase() + v.substring(1).replaceAll('_', ' ');

  static String _clock(dynamic iso) {
    final t = DateTime.tryParse((iso ?? '').toString())?.toLocal();
    if (t == null) return '';
    final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
    return '$h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'am' : 'pm'}';
  }

  /// `.pill-row`. Not one of these is about a dose: the camera's own minutes,
  /// the last room, home or away, and anything unread.
  List<Widget> _headPills() {
    final tracked = _daySummary['tracked_minutes'];
    final coverageKnown =
        _insights.any((i) => i['key'] == 'coverage' && i['value'] != null);
    return [
      if (tracked is num && tracked > 0)
        BentoPill(
          icon: Icons.videocam_outlined,
          label: tracked >= 60
              ? 'Camera recorded ${(tracked / 60).round()}h today'
              : 'Camera recorded ${tracked.round()} min today',
          tone: PillTone.on,
        )
      else if (coverageKnown)
        const BentoPill(
          icon: Icons.videocam_off_outlined,
          label: 'No frames recorded today',
          tone: PillTone.off,
        ),
      if (_lastRoom != null)
        BentoPill(
          icon: Icons.home_outlined,
          label: 'Last in the ${_titleCase(_lastRoom!)}',
          sub: _lastEvent == null ? null : _clock(_lastEvent!['at']),
        ),
      if (_unread.isNotEmpty)
        BentoPill(
          icon: Icons.warning_amber_rounded,
          label: _unread.length == 1 ? '1 alert' : '${_unread.length} alerts',
          tone: PillTone.alert,
        ),
    ];
  }

  /// Push a screen, wrapping it in a Scaffold only when it has no AppBar of
  /// its own -- the same split the More list makes.
  void _go(Widget screen, {bool bare = false, String title = ''}) {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => bare
          ? screen
          : Scaffold(appBar: AppBar(title: Text(title)), body: screen),
    ));
  }

  static const _kindIcon = {
    'routine': Icons.home_outlined,
    'activity': Icons.directions_walk,
    'medication': Icons.medication_outlined,
    'social': Icons.people_outline,
    'items': Icons.inventory_2_outlined,
    'moment': Icons.photo_camera_outlined,
    'anomaly': Icons.warning_amber_rounded,
  };

  /// The day's events: the last nine, newest first. Rooms, activities,
  /// people, belongings and moments -- medicine is ONE kind among them, which
  /// is the whole point of this card. The dose list lives on its own card.
  Widget _todayFeed() {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: LocusTokens.space5),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_timeline.isEmpty) {
      return const CardEmpty(
        icon: Icons.calendar_month_outlined,
        text: 'Rooms, people and belongings appear here as the camera '
            'recognises them through the day.',
      );
    }
    final rows = _timeline.reversed.take(9).toList();
    return Column(
      children: [
        for (final e in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: LocusTokens.space3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 58,
                  child: Text(_clock(e['at']),
                      style: const TextStyle(
                          fontSize: 13, color: AppColors.textMuted)),
                ),
                Container(
                  width: 26,
                  height: 26,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AppColors.surface2,
                    shape: BoxShape.circle,
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Icon(
                      _kindIcon[e['kind']] ?? Icons.calendar_month_outlined,
                      size: 13, color: AppColors.textSecondary),
                ),
                const SizedBox(width: LocusTokens.space3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text((e['title'] ?? '').toString(),
                          style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: AppColors.textPrimary)),
                      if ((e['detail'] ?? '').toString().isNotEmpty)
                        Text(e['detail'].toString(),
                            style: const TextStyle(
                                fontSize: 13, color: AppColors.textSecondary)),
                      // What was said, on the row for the moment it was said.
                      if (e['conversation'] != null &&
                          (e['conversation']['summary'] ?? '')
                              .toString()
                              .isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 3),
                          child: Text(
                            e['conversation']['summary'].toString(),
                            style: const TextStyle(
                                fontSize: 13,
                                fontStyle: FontStyle.italic,
                                color: AppColors.textSecondary),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _routineBody() {
    final f = _findings;
    if (f.isEmpty) {
      return Text(
        _hasBaseline
            ? 'Nothing unusual against your usual pattern.'
            : 'Still learning this routine — there is not enough history yet '
                'to say what usual looks like for you.',
        style: const TextStyle(fontSize: 14, color: AppColors.textSecondary),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final t in f.take(4))
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.warning_amber_rounded,
                    size: 14, color: AppColors.warning),
                const SizedBox(width: 8),
                Expanded(
                    child: Text(t,
                        style: const TextStyle(
                            fontSize: 14, color: AppColors.textPrimary))),
              ],
            ),
          ),
      ],
    );
  }

  Widget _belongingsBody() {
    // Enrolled first, sightings layered on. An item nobody has pointed the
    // camera at is still the person's belonging, and saying so beats claiming
    // they own nothing.
    final seen = {
      for (final it in _items)
        if (it['item_id'] != null) it['item_id'].toString(): it,
    };

    if (_enrolled.isEmpty && _items.isEmpty) {
      return CardEmpty(
        icon: Icons.inventory_2_outlined,
        text: 'Nothing enrolled yet. Once an item is enrolled, this shows '
            'where it was last seen.',
        actionLabel: 'Enrol an item',
        onAction: () => _go(const MyItemsScreen(), bare: true),
      );
    }

    // /user-items calls it item_name, /user-items/last-seen calls it name.
    final rows = _enrolled.isNotEmpty
        ? _enrolled.map((e) {
            final id = (e['_id'] ?? '').toString();
            final hit = seen[id];
            return {
              'name': (e['item_name'] ?? e['name'] ?? 'Item').toString(),
              'placement': hit?['placement'],
              'at': hit?['at'],
            };
          }).toList()
        : _items.map((e) => {
              'name': (e['name'] ?? 'Item').toString(),
              'placement': e['placement'],
              'at': e['at'],
            }).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Raised by the backend against a real baseline, not inferred here.
        if (_leftBehind.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: LocusTokens.space2),
            child: Row(
              children: [
                const Icon(Icons.warning_amber_rounded,
                    size: 14, color: AppColors.danger),
                const SizedBox(width: 8),
                Expanded(
                    child: Text((_leftBehind.first['title'] ?? '').toString(),
                        style: const TextStyle(
                            fontSize: 14, color: AppColors.dangerText))),
              ],
            ),
          ),
        for (final it in rows.take(4))
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.inventory_2_outlined,
                    size: 14, color: AppColors.textSecondary),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(it['name'].toString(),
                          style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: AppColors.textPrimary)),
                      Text(
                        it['at'] == null
                            // Said plainly rather than left blank: the item is
                            // enrolled, it simply has not been seen.
                            ? 'Not seen in the last three days'
                            : [
                                if ((it['placement'] ?? '').toString().isNotEmpty)
                                  _titleCase(it['placement'].toString()),
                                _clock(it['at']),
                              ].where((x) => x.isNotEmpty).join(' · '),
                        style: const TextStyle(
                            fontSize: 13, color: AppColors.textMuted),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _peopleBody() {
    if (_peopleToday.isEmpty) {
      return const CardEmpty(
          icon: Icons.people_outline,
          text: 'Nobody has been recognised today.');
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final p in _peopleToday.take(4))
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                const Icon(Icons.people_outline,
                    size: 14, color: AppColors.textSecondary),
                const SizedBox(width: 8),
                Expanded(
                    child: Text(p,
                        style: const TextStyle(
                            fontSize: 14, color: AppColors.textPrimary))),
              ],
            ),
          ),
      ],
    );
  }

  Widget _conversationsBody() {
    if (_convos.isEmpty) {
      return const CardEmpty(
        icon: Icons.chat_bubble_outline,
        text: 'No conversation has been heard today. The microphone only runs '
            'when a face is in view.',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final c in _convos.take(3))
          Padding(
            padding: const EdgeInsets.only(bottom: LocusTokens.space3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                          (c['person_name'] ?? c['title'] ?? 'Someone')
                              .toString(),
                          style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: AppColors.textPrimary)),
                    ),
                    Text(_clock(c['at']),
                        style: const TextStyle(
                            fontSize: 13, color: AppColors.textMuted)),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  (c['summary'] ?? '').toString().isNotEmpty
                      ? c['summary'].toString()
                      : 'No summary.',
                  style: const TextStyle(
                      fontSize: 14, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _nextDoseBody() {
    final d = _nextDose;
    if (d == null) {
      return const CardEmpty(
          icon: Icons.medication_outlined, text: 'Nothing else is due today.');
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(_clock(d['scheduled_time']),
            style: const TextStyle(
                fontSize: 19,
                fontWeight: FontWeight.w700,
                color: AppColors.textPrimary)),
        const SizedBox(width: LocusTokens.space3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text((d['medication_name'] ?? '').toString(),
                  style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary)),
              if ((d['dosage'] ?? '').toString().isNotEmpty)
                Text(d['dosage'].toString(),
                    style: const TextStyle(
                        fontSize: 13, color: AppColors.textMuted)),
            ],
          ),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: d['status'] == 'snoozed'
                ? AppColors.warningLight
                : AppColors.infoLight,
            borderRadius: BorderRadius.circular(LocusTokens.radiusPill),
          ),
          child: Text(d['status'] == 'snoozed' ? 'Snoozed' : 'Scheduled',
              style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: d['status'] == 'snoozed'
                      ? AppColors.warning
                      : AppColors.info)),
        ),
      ],
    );
  }

  static const List<String> _months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  static const List<String> _days = [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  ];

  /// `.bento-date` -- "Friday, 14 November". Written out rather than through
  /// intl, which this project does not carry.
  String _longDate(DateTime d) =>
      '${_days[d.weekday - 1]}, ${d.day} ${_months[d.month - 1]}';

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final greeting = now.hour < 12
        ? 'Good morning'
        : now.hour < 17
            ? 'Good afternoon'
            : 'Good evening';
    final who = (ApiService.user?['name'] ?? '').toString().split(' ').first;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_emergencyNotices.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: BentoBanner(
              icon: Icons.warning_amber_rounded,
              title: 'An emergency alert is active',
              subtitle: (_emergencyNotices.first['title'] ?? '').toString(),
              emergency: true,
            ),
          ),

        BentoHead(
          date: _longDate(now),
          greeting: who.isNotEmpty ? '$greeting, $who' : greeting,
          status: _statusLine,
          initial: who.isNotEmpty ? who[0].toUpperCase() : null,
          pills: _headPills(),
        ),
        const SizedBox(height: 14),

        for (final w in widget.beforeCards) ...[w, const SizedBox(height: 14)],

        BentoCard(
          icon: Icons.calendar_month_outlined,
          title: 'Today',
          actionLabel: 'Full feed',
          onAction: () => _go(const ActivityScreen(), title: 'Activity'),
          child: _todayFeed(),
        ),
        const SizedBox(height: 14),

        BentoCard(
          icon: Icons.calendar_month_outlined,
          title: 'Routine',
          actionLabel: 'Open',
          onAction: () =>
              _go(RoutineScreen(userId: widget.userId), bare: true),
          child: _routineBody(),
        ),
        const SizedBox(height: 14),

        BentoCard(
          icon: Icons.inventory_2_outlined,
          title: 'Belongings',
          actionLabel: 'Open',
          onAction: () => _go(const MyItemsScreen(), bare: true),
          child: _belongingsBody(),
        ),
        const SizedBox(height: 14),

        BentoCard(
          icon: Icons.people_outline,
          title: 'People',
          actionLabel: 'Review faces',
          onAction: () => _go(const KeyframeAuditScreen(), bare: true),
          child: _peopleBody(),
        ),
        const SizedBox(height: 14),

        BentoCard(
          icon: Icons.chat_bubble_outline,
          title: 'Conversations',
          actionLabel: 'Open',
          // MemoryScreen builds no Scaffold of its own, so it has to be
          // given one; pushed bare it has no surface and no way back.
          onAction: () => _go(const MemoryScreen(), title: 'Memory'),
          child: _conversationsBody(),
        ),
        const SizedBox(height: 14),

        // A caregiver's question: where is the person now.
        if (widget.canAct) ...[
          BentoCard(
            icon: Icons.place_outlined,
            title: 'Location',
            actionLabel: 'Map',
            onAction: () => _go(const LocationMapScreen(), bare: true),
            child: Text(
              _fix?['lat'] == null
                  ? 'No location has been reported yet.'
                  : 'Last placed ${_clock(_fix!['timestamp'])}.',
              style: const TextStyle(fontSize: 14, color: AppColors.textSecondary),
            ),
          ),
          const SizedBox(height: 14),
        ],

        BentoCard(
          icon: Icons.medication_outlined,
          title: 'Next dose',
          actionLabel: 'Open',
          // Two different screens, because these are two different questions.
          //
          // This always opened MedicationScreen, which is the WEARER'S OWN
          // medication page -- it reads the signed-in account's doses and has
          // no notion of looking after somebody. A caregiver who tapped Open
          // on a card about the person they monitor landed on a page about
          // themselves, which is empty, because a caregiver has no prescribed
          // doses of their own. The card said one thing and the page it opened
          // said another.
          //
          // The web has always split these: `canAct ? '/medications' :
          // '/my-medications'`. This is the same split.
          onAction: () => widget.canAct
              ? _go(const CaregiverMedicationsScreen(), title: 'Medication')
              : _go(const MedicationScreen(), title: 'Medication'),
          child: _nextDoseBody(),
        ),
      ],
    );
  }
}
