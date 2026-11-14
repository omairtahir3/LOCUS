import 'package:flutter/material.dart';

import '../../services/api_service.dart';
import '../../services/selected_user_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/bento.dart';

/// What today looked like, and what the system has actually learned.
///
/// The mobile twin of web_app/frontend/src/pages/Routine.jsx, and it reads the
/// same single endpoint -- GET /event-logs/timeline -- so no new API was
/// needed.
///
/// THE TWO HALVES ARE DELIBERATELY NOT MIXED.
///
/// "Today's pattern" is observation: the room and activity sessions the camera
/// recorded today. It is NOT a routine. One day is not a baseline, and drawing
/// it as one would tell a caregiver the system understands a person it has
/// barely met.
///
/// "Findings" is the only half that comes from learning -- RoutineFinding rows
/// written against a 30-day baseline, surfaced through the same endpoint as
/// `anomalies`.
///
/// WHAT IS NOT SHOWN: no progress bar towards a baseline, no "day 12 of 30",
/// no percentage of routine learned. No endpoint reports any of those, so each
/// would be a number invented on this screen. Where the API cannot compute a
/// measure it returns value: null with a sentence saying why, and that
/// sentence is what gets printed -- 0% and "we cannot tell" are different
/// claims.
class RoutineScreen extends StatefulWidget {
  const RoutineScreen({super.key, this.userId});

  /// A caregiver viewing one of the people they look after.
  final String? userId;

  @override
  State<RoutineScreen> createState() => _RoutineScreenState();
}

class _RoutineScreenState extends State<RoutineScreen> {
  Map<String, dynamic>? _data;
  bool _loading = true;

  /// Whose routine this is. Null means the signed-in person's own.
  String? _subjectId;
  String? _subjectName;

  @override
  void initState() {
    super.initState();

    // A CAREGIVER WAS BEING SHOWN THEIR OWN ROUTINE.
    //
    // The More list opened this screen as `const RoutineScreen()` -- no
    // userId -- so the timeline came back scoped to the caregiver, who wears
    // no camera and therefore has no room sessions, no activity sessions and
    // no baseline. The page then described that emptiness in the second
    // person ("not enough history to say what usual looks like for you"),
    // which reads as a true statement about the person they are monitoring.
    // It was the wrong person's data under the right person's heading.
    //
    // Resolved here rather than at each call site so that any caller gets the
    // right scope: an explicit userId wins, and a caregiver who passed none
    // falls back to whoever the person switcher has selected.
    final sel = SelectedUserService().selectedUser;
    // Read out here rather than inside the conditionals below: `sel?['_id']`
    // sitting after a `?` parses as a second conditional expression, and the
    // analyser reports it as "conditions must have a static type of bool"
    // pointing at `sel`, which does not look like a syntax problem at all.
    final selId = sel?['_id']?.toString();
    final selName = sel?['name']?.toString();
    final caring = ApiService.userRole == 'caregiver';
    _subjectId = widget.userId ?? (caring ? selId : null);
    // Only name them when the selection is actually the subject; otherwise the
    // banner would caption one person's data with another's name.
    _subjectName = (_subjectId != null && selId == _subjectId) ? selName : null;

    _load();
  }

  /// The person the sentences on this screen are about.
  String get _who => _subjectName ?? 'you';

  /// "your" / "Mohammad Tahir's".
  String get _possessive => _subjectName == null ? 'your' : "$_subjectName's";

  /// A caregiver who has not picked anybody: the screen can only show their
  /// own empty timeline, and saying so beats a blank.
  bool get _unscoped =>
      ApiService.userRole == 'caregiver' && _subjectId == null;

  Future<void> _load() async {
    final d = await ApiService.getActivityTimeline(userId: _subjectId)
        .catchError((_) => null);
    if (!mounted) return;
    setState(() {
      _data = d;
      _loading = false;
    });
  }

  List<dynamic> get _findings => (_data?['anomalies'] as List<dynamic>?) ?? [];
  List<dynamic> get _insights => (_data?['insights'] as List<dynamic>?) ?? [];

  /// Room and activity sessions are the shape of a day. Doses, faces and item
  /// sightings belong to their own screens.
  List<dynamic> get _pattern => ((_data?['items'] as List<dynamic>?) ?? [])
      .where((i) => i['kind'] == 'routine' || i['kind'] == 'activity')
      .toList();

  /// Null means the endpoint could not compute it. None measurable at all
  /// means there is no baseline, and then a figure of any kind is invented.
  bool get _hasBaseline => _insights.any((i) => i['value'] != null);

  static String _clock(dynamic iso) {
    final t = DateTime.tryParse((iso ?? '').toString())?.toLocal();
    if (t == null) return '';
    final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
    return '$h:${t.minute.toString().padLeft(2, '0')} ${t.hour < 12 ? 'am' : 'pm'}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Routine')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
                children: [
                  if (_subjectName != null || _unscoped) _subjectBanner(),
                  Text(
                    "Today's pattern, and what LOCUS has learned about "
                    '$_possessive normal',
                    style: const TextStyle(
                        fontSize: 14, color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: 14),

                  BentoCard(
                    icon: Icons.calendar_month_outlined,
                    title: 'Findings',
                    child: _findingsBody(),
                  ),
                  const SizedBox(height: 14),

                  BentoCard(
                    icon: Icons.home_outlined,
                    title: "Today's pattern",
                    child: _patternBody(),
                  ),
                ],
              ),
            ),
    );
  }

  /// Whose routine this is, said first and said plainly.
  ///
  /// Everything under it -- the findings, the baseline measures, today's
  /// pattern -- is about one person, and a caregiver looking after more than
  /// one could otherwise read the whole screen without registering which.
  /// "Nothing unusual" about the wrong person is worse than no answer.
  /// Look at somebody else's routine.
  ///
  /// Writes through SelectedUserService, the same store the Medications,
  /// Activity, Location, Keyframe and Memory screens switch on, so changing
  /// person here changes it everywhere rather than only on this screen.
  Future<void> _switchTo(String userId) async {
    final service = SelectedUserService();
    await service.setSelectedUser(userId);
    if (!mounted) return;
    final sel = service.selectedUser;
    setState(() {
      _subjectId = sel?['_id']?.toString() ?? userId;
      _subjectName = sel?['name']?.toString();
      _loading = true;
    });
    await _load();
  }

  Widget _subjectBanner() {
    final name = _subjectName;
    final initial =
        (name == null || name.trim().isEmpty) ? '?' : name.trim()[0].toUpperCase();
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: name == null ? AppColors.surface : AppColors.primaryLight,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 21,
            backgroundColor: name == null ? AppColors.border : AppColors.primary,
            child: Text(
              initial,
              style: TextStyle(
                color: name == null ? AppColors.textMuted : Colors.white,
                fontWeight: FontWeight.w700,
                fontSize: 16,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'ROUTINE BEING MONITORED',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: .6,
                    color: name == null
                        ? AppColors.textMuted
                        : AppColors.primaryText,
                  ),
                ),
                const SizedBox(height: 3),
                _subjectNameField(name),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The person's name, and -- when the caregiver looks after more than one
  /// -- the control that changes which one.
  ///
  /// The web does not need this: PersonSwitcher sits in the top dock on every
  /// caregiver page there, so one control serves the whole app. Mobile has no
  /// such dock, which is why Medications, Activity, Location, Keyframes and
  /// Memory each carry their own picker. Routine was the only caregiver screen
  /// without one, so a caregiver with two people could read a routine about
  /// whichever of them some other screen happened to have selected last, with
  /// no way to change it from here.
  ///
  /// Folded into the banner rather than added beside it: the banner already
  /// answers "who is this about", and a separate dropdown would ask the same
  /// question twice in one header.
  Widget _subjectNameField(String? name) {
    final people = SelectedUserService().monitoringUsers;
    final style = TextStyle(
      fontSize: 17,
      fontWeight: name == null ? FontWeight.w600 : FontWeight.w700,
      color: name == null ? AppColors.textMuted : AppColors.textPrimary,
    );

    // One person, or none: there is nothing to choose between.
    if (people.length < 2) {
      return Text(
        name ?? 'No family member selected',
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }

    // DropdownButton asserts if `value` is not among its items, which happens
    // when this screen was opened with an explicit userId for somebody who is
    // not on the monitoring list. Null shows the hint instead of crashing.
    final ids = people.map((u) => u['_id']?.toString()).toSet();
    final value = ids.contains(_subjectId) ? _subjectId : null;

    return DropdownButtonHideUnderline(
      child: DropdownButton<String>(
        isDense: true,
        isExpanded: true,
        value: value,
        hint: Text('Choose a family member', style: style),
        icon: const Icon(Icons.arrow_drop_down,
            color: AppColors.textSecondary, size: 22),
        style: style,
        onChanged: (v) {
          if (v != null) _switchTo(v);
        },
        items: people.map<DropdownMenuItem<String>>((dynamic u) {
          return DropdownMenuItem<String>(
            value: u['_id']?.toString(),
            child: Text(
              (u['name'] ?? 'Unknown').toString(),
              overflow: TextOverflow.ellipsis,
              style: style,
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _findingsBody() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('From the 30-day baseline, not from today',
            style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
        const SizedBox(height: LocusTokens.space3),
        if (_findings.isEmpty)
          CardEmpty(
            icon: Icons.calendar_month_outlined,
            text: _hasBaseline
                ? 'Nothing has been flagged against $_possessive usual '
                    'pattern today.'
                : 'There is not enough history yet to say what usual looks '
                    'like for $_who. Findings appear once there is.',
          )
        else
          for (final f in _findings)
            Padding(
              padding: const EdgeInsets.only(bottom: LocusTokens.space3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.warning_amber_rounded,
                      size: 16, color: AppColors.warningText),
                  const SizedBox(width: LocusTokens.space2),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text((f['title'] ?? '').toString(),
                            style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                                color: AppColors.textPrimary)),
                        if ((f['detail'] ?? '').toString().isNotEmpty)
                          Text(f['detail'].toString(),
                              style: const TextStyle(
                                  fontSize: 14,
                                  color: AppColors.textSecondary)),
                      ],
                    ),
                  ),
                  Text(_clock(f['at']),
                      style: const TextStyle(
                          fontSize: 13, color: AppColors.textMuted)),
                ],
              ),
            ),

        // Only once something is measurable. The endpoint's own sentence is
        // printed under each measure, including the ones it could not do.
        if (_hasBaseline) ...[
          const Divider(height: 24),
          for (final ins in _insights)
            Padding(
              padding: const EdgeInsets.only(bottom: LocusTokens.space3),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text((ins['label'] ?? '').toString(),
                            style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                                color: AppColors.textPrimary)),
                      ),
                      // An em dash, not 0%: "we cannot tell" and "nothing
                      // happened" are different claims.
                      Text(
                        ins['value'] == null ? '—' : '${ins['value']}%',
                        style: TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                          color: ins['value'] == null
                              ? AppColors.textMuted
                              : AppColors.primaryText,
                        ),
                      ),
                    ],
                  ),
                  if ((ins['detail'] ?? '').toString().isNotEmpty)
                    Text(ins['detail'].toString(),
                        style: const TextStyle(
                            fontSize: 13, color: AppColors.textMuted)),
                ],
              ),
            ),
        ],
      ],
    );
  }

  Widget _patternBody() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Recorded today — observation, not a learned routine',
            style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
        const SizedBox(height: LocusTokens.space3),
        if (_pattern.isEmpty)
          const CardEmpty(
            icon: Icons.home_outlined,
            text: 'Nothing recorded yet today. Room visits and activities '
                'appear here as the camera recognises them.',
          )
        else
          for (final p in _pattern)
            Padding(
              padding: const EdgeInsets.only(bottom: LocusTokens.space3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 62,
                    child: Text(_clock(p['at']),
                        style: const TextStyle(
                            fontSize: 13, color: AppColors.textMuted)),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text((p['title'] ?? '').toString(),
                            style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                                color: AppColors.textPrimary)),
                        if ((p['detail'] ?? '').toString().isNotEmpty)
                          Text(p['detail'].toString(),
                              style: const TextStyle(
                                  fontSize: 14,
                                  color: AppColors.textSecondary)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
      ],
    );
  }
}
