import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/selected_user_service.dart';

/// One day of what the camera and the phone actually recorded.
///
/// This screen used to render a hard-coded list -- "Met with neighbor Mrs.
/// Johnson", "~2,400 steps", four insight bars with fixed percentages -- under
/// the caption "Sample data, Module 1 backend required". Everything here now
/// comes from GET /event-logs/timeline, the same endpoint the web Activity
/// Feed uses, so the two cannot drift apart.
class ActivityFeedScreen extends StatefulWidget {
  const ActivityFeedScreen({super.key});

  @override
  State<ActivityFeedScreen> createState() => _ActivityFeedScreenState();
}

class _ActivityFeedScreenState extends State<ActivityFeedScreen> {
  static const Map<String, Color> _kindColors = {
    'routine': AppColors.primary,
    'medication': AppColors.success,
    'social': AppColors.accent,
    'items': AppColors.info,
    'activity': AppColors.accent,
    'anomaly': AppColors.warning,
  };

  static const Map<String, IconData> _kindIcons = {
    'routine': Icons.home_outlined,
    'medication': Icons.medication_outlined,
    'social': Icons.psychology_outlined,
    'items': Icons.inventory_2_outlined,
    'activity': Icons.directions_run_outlined,
    'anomaly': Icons.warning_amber_outlined,
  };

  DateTime _date = DateTime.now();
  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _error;

  /// The user's LOCAL day. Formatting in UTC would move the whole day by the
  /// offset from UTC, so "today" on the phone would not be today on the server.
  String get _dateParam => DateFormat('yyyy-MM-dd').format(_date);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final data = await ApiService.getActivityTimeline(
        date: _dateParam,
        // A caregiver views whichever person is selected; for anyone else the
        // server falls back to the caller's own id.
        userId: SelectedUserService().selectedUser?['_id'] as String?,
      );
      if (!mounted) return;
      setState(() { _data = data; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _error = 'Could not load the timeline'; _loading = false; });
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
    );
    if (picked != null) {
      setState(() => _date = picked);
      _load();
    }
  }

  void _shiftDay(int days) {
    final next = _date.add(Duration(days: days));
    if (next.isAfter(DateTime.now())) return;
    setState(() => _date = next);
    _load();
  }

  bool get _isToday => DateUtils.isSameDay(_date, DateTime.now());

  /// 12-hour, everywhere, so the app never shows 14:05 on one screen and
  /// 2:05 PM on another.
  String _clock(String? iso) {
    if (iso == null) return '';
    final dt = DateTime.tryParse(iso);
    return dt == null ? '' : DateFormat('h:mm a').format(dt.toLocal());
  }

  String _duration(num? minutes) {
    final m = (minutes ?? 0).round();
    if (m <= 0) return '0m';
    final h = m ~/ 60;
    return h > 0 ? '${h}h ${m % 60}m' : '${m}m';
  }

  @override
  Widget build(BuildContext context) {
    final summary = (_data?['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
    final items = (_data?['items'] as List?) ?? const [];
    final anomalies = (_data?['anomalies'] as List?) ?? const [];
    final insights = (_data?['insights'] as List?) ?? const [];
    final steps = summary['steps'];

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          _dateBar(),
          const SizedBox(height: 16),

          if (_loading)
            const Padding(padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()))
          else if (_error != null)
            _emptyCard(Icons.error_outline, _error!, 'Pull down to try again.')
          else ...[
            // Six figures, two per row.
            GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              childAspectRatio: 2.0,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
              children: [
                _stat(Icons.medication_outlined, AppColors.success,
                    '${summary['medication'] ?? '—'}', 'Doses Seen'),
                _stat(Icons.psychology_outlined, AppColors.accent,
                    '${summary['social'] ?? '—'}', 'Social Interactions'),
                _stat(Icons.directions_walk_outlined, AppColors.primary,
                    steps == null ? '—' : NumberFormat.decimalPattern().format(steps), 'Steps Today'),
                _stat(Icons.inventory_2_outlined, AppColors.info,
                    '${summary['items_seen'] ?? '—'}', 'Items Found'),
                // Green at zero: nothing wrong is good news, and an amber
                // badge on a zero reads as a problem.
                _stat(
                  (summary['anomalies'] ?? 0) == 0 ? Icons.verified_user_outlined : Icons.warning_amber_outlined,
                  (summary['anomalies'] ?? 0) == 0 ? AppColors.success : AppColors.warning,
                  '${summary['anomalies'] ?? '—'}', 'Anomalies',
                ),
                _stat(Icons.schedule_outlined, AppColors.primary,
                    summary.isEmpty ? '—' : _duration(summary['tracked_minutes'] as num?), 'Camera Time'),
              ],
            ),
            const SizedBox(height: 16),
            _timelineCard(items),
            const SizedBox(height: 16),
            _anomaliesCard(anomalies),
            const SizedBox(height: 16),
            _insightsCard(insights),
          ],
        ],
      ),
    );
  }

  Widget _dateBar() {
    return Row(
      children: [
        IconButton(
          onPressed: () => _shiftDay(-1),
          icon: const Icon(Icons.chevron_left),
          tooltip: 'Previous day',
        ),
        Expanded(
          child: InkWell(
            onTap: _pickDate,
            borderRadius: BorderRadius.circular(10),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
              decoration: BoxDecoration(
                color: AppColors.surface,
                border: Border.all(color: AppColors.border),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.calendar_today_outlined, size: 16, color: AppColors.textMuted),
                  const SizedBox(width: 8),
                  Text(
                    _isToday ? 'Today' : DateFormat('EEEE d MMMM').format(_date),
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                  ),
                ],
              ),
            ),
          ),
        ),
        IconButton(
          onPressed: _isToday ? null : () => _shiftDay(1),
          icon: const Icon(Icons.chevron_right),
          tooltip: 'Next day',
        ),
      ],
    );
  }

  Widget _card({required Widget child}) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: child,
      );

  Widget _stat(IconData icon, Color color, String value, String label) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Container(
              width: 36, height: 36,
              decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
              child: Icon(icon, size: 18, color: color),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  ),
                  Text(label, style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _emptyCard(IconData icon, String title, String detail) => _card(
        child: Column(
          children: [
            Icon(icon, size: 28, color: AppColors.textMuted),
            const SizedBox(height: 10),
            Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(detail, textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.5)),
          ],
        ),
      );

  Widget _timelineCard(List items) {
    if (items.isEmpty) {
      return _emptyCard(Icons.timeline_outlined, 'Nothing recorded on this day',
          'The feed fills as the camera runs. Room sessions, medication, familiar faces and tracked items all appear here.');
    }
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Timeline', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text('${items.length} ${items.length == 1 ? 'entry' : 'entries'}',
              style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
          const SizedBox(height: 14),
          ...items.asMap().entries.map((e) {
            final i = e.key;
            final it = (e.value as Map).cast<String, dynamic>();
            final kind = '${it['kind']}';
            final color = _kindColors[kind] ?? AppColors.textMuted;
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Column(
                  children: [
                    Container(
                      width: 32, height: 32,
                      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), shape: BoxShape.circle),
                      child: Icon(_kindIcons[kind] ?? Icons.circle_outlined, size: 15, color: color),
                    ),
                    if (i < items.length - 1)
                      Container(width: 2, height: 30, color: AppColors.border),
                  ],
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(child: Text('${it['title']}',
                                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5))),
                            Text(_clock(it['at'] as String?),
                                style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                          ],
                        ),
                        if ('${it['detail']}'.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text('${it['detail']}',
                                style: const TextStyle(fontSize: 12, color: AppColors.textSecondary, height: 1.4)),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            );
          }),
        ],
      ),
    );
  }

  Widget _anomaliesCard(List anomalies) {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Anomalies', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(anomalies.isEmpty
                  ? 'Nothing out of the ordinary'
                  : '${anomalies.length} thing${anomalies.length == 1 ? '' : 's'} LOCUS noticed',
              style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
          const SizedBox(height: 12),
          if (anomalies.isEmpty)
            Row(children: const [
              Icon(Icons.verified_user_outlined, size: 18, color: AppColors.success),
              SizedBox(width: 10),
              Expanded(child: Text(
                'The day matched the usual pattern. Missed doses, long stretches without movement and items left behind would appear here.',
                style: TextStyle(fontSize: 12, color: AppColors.textMuted, height: 1.5))),
            ])
          else
            ...anomalies.map((a) {
              final an = (a as Map).cast<String, dynamic>();
              final sev = '${an['severity']}';
              final color = sev == 'urgent' ? AppColors.danger
                  : sev == 'warning' ? AppColors.warning : AppColors.info;
              return Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.06),
                  borderRadius: BorderRadius.circular(10),
                  border: Border(left: BorderSide(color: color, width: 3)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: Text('${an['title']}',
                            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
                        Text(_clock(an['at'] as String?),
                            style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text('${an['detail']}',
                        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary, height: 1.4)),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _insightsCard(List insights) {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Behavioural Insights',
              style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('How the day compares with what is expected',
              style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
          const SizedBox(height: 14),
          if (insights.isEmpty)
            const Text('No insights for this day yet.',
                style: TextStyle(fontSize: 12, color: AppColors.textMuted))
          else
            ...insights.map((m) {
              final ins = (m as Map).cast<String, dynamic>();
              final value = ins['value'];
              // A metric with no data shows no bar. A plausible-looking bar
              // standing in for a missing measurement is worse than a gap.
              final pct = value is num ? value.toDouble().clamp(0, 100) : null;
              final color = pct == null ? AppColors.textMuted
                  : pct >= 70 ? AppColors.success
                  : pct >= 40 ? AppColors.warning : AppColors.danger;
              return Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(child: Text('${ins['label']}', style: const TextStyle(fontSize: 13))),
                        Text(pct == null ? 'No data' : '${pct.round()}%',
                            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700,
                                color: pct == null ? AppColors.textMuted : AppColors.textPrimary)),
                      ],
                    ),
                    const SizedBox(height: 5),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(4),
                      child: LinearProgressIndicator(
                        value: (pct ?? 0) / 100,
                        minHeight: 8,
                        backgroundColor: AppColors.borderLight,
                        valueColor: AlwaysStoppedAnimation<Color>(color),
                      ),
                    ),
                    if ('${ins['detail']}'.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text('${ins['detail']}',
                            style: const TextStyle(fontSize: 11, color: AppColors.textMuted, height: 1.4)),
                      ),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }
}
