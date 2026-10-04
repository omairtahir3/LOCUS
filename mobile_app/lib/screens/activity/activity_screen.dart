import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../services/api_service.dart';
import '../../services/selected_user_service.dart';
import '../../theme/app_theme.dart';

/// Module 6 FE-1: the day as the system actually recorded it.
///
/// This screen was a mockup. It said "Coming Soon" and drew seven invented
/// events, 4,200 steps and a 90% sleep score for a system that does not measure
/// sleep, over a hardcoded list that could never change. The helpers below were
/// already written to take real rows; only the data was imaginary.
///
/// It reads /event-logs/timeline now, which is the same endpoint the web
/// Activity Feed uses, so the two cannot drift apart or disagree about what
/// happened. An empty day says so rather than showing a fictional one, which
/// matters more here than anywhere else in the app: this is the screen a
/// caregiver would use to decide whether anything is wrong.
class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  Map<String, dynamic>? _data;
  bool _loading = true;
  String? _error;
  DateTime _date = DateTime.now();

  bool get _isToday => DateUtils.isSameDay(_date, DateTime.now());

  @override
  void initState() {
    super.initState();
    SelectedUserService().addListener(_onUserChanged);
    _load();
  }

  @override
  void dispose() {
    SelectedUserService().removeListener(_onUserChanged);
    super.dispose();
  }

  void _onUserChanged() {
    if (mounted) _load();
  }

  /// Called by the shell when this tab is tapped.
  void reload() {
    if (mounted) _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      String? selected;
      if (ApiService.userRole == 'caregiver') {
        selected = SelectedUserService().selectedUser?['_id']?.toString();
      }
      final res = await ApiService.getActivityTimeline(
        userId: selected,
        date: DateFormat('yyyy-MM-dd').format(_date),
      );
      if (!mounted) return;
      setState(() {
        _data = res;
        // null means the request failed, which is a different thing from a day
        // with nothing in it and must not be drawn as one.
        _error = res == null ? 'Could not reach the server' : null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  void _shiftDay(int days) {
    final next = _date.add(Duration(days: days));
    if (next.isAfter(DateTime.now())) return;
    setState(() => _date = next);
    _load();
  }

  // Each kind the timeline can return, given a face. 'items' covers belongings,
  // which is most of what this system sees.
  static const _kindIcon = {
    'medication': Icons.medication_outlined,
    'social': Icons.people_outline,
    'items': Icons.inventory_2_outlined,
    'activity': Icons.directions_walk,
    'anomaly': Icons.warning_amber,
  };
  static const _kindColor = {
    'medication': AppColors.success,
    'social': AppColors.accent,
    'items': AppColors.primary,
    'activity': AppColors.info,
    'anomaly': AppColors.warning,
  };

  @override
  Widget build(BuildContext context) {
    final summary = (_data?['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
    final items = (_data?['items'] as List?) ?? const [];
    final anomalies = (_data?['anomalies'] as List?) ?? const [];
    final insights = (_data?['insights'] as List?) ?? const [];

    return RefreshIndicator(
      onRefresh: _load,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Expanded(
                  child: Text('Activity Summary',
                      style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                ),
                IconButton(
                  onPressed: () => _shiftDay(-1),
                  icon: const Icon(Icons.chevron_left),
                  tooltip: 'Previous day',
                ),
                Text(
                  _isToday ? 'Today' : DateFormat('d MMM').format(_date),
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
                ),
                IconButton(
                  onPressed: _isToday ? null : () => _shiftDay(1),
                  icon: const Icon(Icons.chevron_right),
                  tooltip: 'Next day',
                ),
              ],
            ),
            Text('What the camera recorded on this day',
                style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
            const SizedBox(height: 20),

            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 60),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              _problem(_error!)
            else ...[
              Row(
                children: [
                  _metricCard('Medicine', '${summary['medication'] ?? 0}',
                      Icons.medication_outlined, AppColors.success),
                  const SizedBox(width: 12),
                  _metricCard('People seen', '${summary['social'] ?? 0}',
                      Icons.people_outline, AppColors.accent),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  _metricCard('Belongings', '${summary['items_seen'] ?? 0}',
                      Icons.inventory_2_outlined, AppColors.primary),
                  const SizedBox(width: 12),
                  _metricCard('Anomalies', '${anomalies.length}',
                      Icons.warning_amber, AppColors.warning),
                ],
              ),
              // Steps come from the phone's own sensor and are simply absent on
              // a device that has none. A dash is honest; a number is not.
              if (summary['steps'] != null) ...[
                const SizedBox(height: 12),
                Row(children: [
                  _metricCard('Steps', '${summary['steps']}',
                      Icons.directions_walk, AppColors.info),
                  const SizedBox(width: 12),
                  _metricCard('Tracked', '${summary['tracked_minutes'] ?? 0} min',
                      Icons.timer_outlined, AppColors.textMuted),
                ]),
              ],
              const SizedBox(height: 24),

              const Text('Daily Timeline',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
              const SizedBox(height: 12),
              if (items.isEmpty)
                _empty('Nothing was recorded on this day.')
              else
                ...items.map((e) => _timelineItem(Map<String, dynamic>.from(e as Map))),

              if (anomalies.isNotEmpty) ...[
                const SizedBox(height: 24),
                const Text('Anomalies',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                const SizedBox(height: 12),
                ...anomalies.map((a) => _anomaly(Map<String, dynamic>.from(a as Map))),
              ],

              if (insights.isNotEmpty) ...[
                const SizedBox(height: 24),
                const Text('Behavioural Insights',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                const SizedBox(height: 12),
                ...insights.map((i) => _insight(Map<String, dynamic>.from(i as Map))),
              ],
            ],
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }

  Widget _problem(String message) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: AppColors.dangerLight,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          children: [
            const Icon(Icons.cloud_off, color: AppColors.danger),
            const SizedBox(height: 8),
            Text(message, textAlign: TextAlign.center,
                style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            // The commonest cause by far, and the one nothing else explains.
            const Text('Check the server address in Settings.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
            const SizedBox(height: 8),
            TextButton(onPressed: _load, child: const Text('Try again')),
          ],
        ),
      );

  Widget _empty(String message) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 28),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          children: [
            Icon(Icons.inbox_outlined, color: AppColors.textMuted, size: 32),
            const SizedBox(height: 8),
            Text(message,
                style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
          ],
        ),
      );

  Widget _metricCard(String label, String value, IconData icon, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                  color: color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(value,
                      style: const TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textPrimary)),
                  Text(label,
                      style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _timelineItem(Map<String, dynamic> item) {
    final kind = item['kind']?.toString() ?? 'activity';
    final color = _kindColor[kind] ?? AppColors.textMuted;
    final icon = _kindIcon[kind] ?? Icons.circle_outlined;
    final at = DateTime.tryParse(item['at']?.toString() ?? '');
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 70,
            child: Text(at == null ? '' : DateFormat('h:mm a').format(at.toLocal()),
                style: TextStyle(
                    fontSize: 11, color: AppColors.textMuted, fontWeight: FontWeight.w600)),
          ),
          Column(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                    color: color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
                child: Icon(icon, size: 16, color: color),
              ),
              Container(width: 2, height: 32, color: AppColors.borderLight),
            ],
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Container(
              margin: const EdgeInsets.only(bottom: 12),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(item['title']?.toString() ?? '',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  if ((item['detail']?.toString() ?? '').isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(item['detail'].toString(),
                        style: TextStyle(color: AppColors.textSecondary, fontSize: 11)),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _anomaly(Map<String, dynamic> a) => Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.warningLight,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            const Icon(Icons.warning_amber, color: AppColors.warning, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(a['title']?.toString() ?? 'Anomaly',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
                  if ((a['detail']?.toString() ?? '').isNotEmpty)
                    Text(a['detail'].toString(),
                        style: const TextStyle(fontSize: 12)),
                ],
              ),
            ),
          ],
        ),
      );

  /// An insight carries a value from 0 to 1, or null when there was nothing to
  /// measure. A null draws its reason instead of a 0% bar, which would read as
  /// a bad day rather than a quiet one.
  Widget _insight(Map<String, dynamic> i) {
    final raw = i['value'];
    final label = i['label']?.toString() ?? '';
    final detail = i['detail']?.toString() ?? '';
    if (raw == null) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
            Flexible(
              child: Text(detail.isEmpty ? 'No data' : detail,
                  textAlign: TextAlign.right,
                  style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ),
          ],
        ),
      );
    }
    final value = (raw as num).toDouble().clamp(0.0, 1.0);
    final color = value >= 0.75
        ? AppColors.success
        : value >= 0.4
            ? AppColors.primary
            : AppColors.warning;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              Text('${(value * 100).toInt()}%',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: color)),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: value,
              backgroundColor: AppColors.borderLight,
              color: color,
              minHeight: 8,
            ),
          ),
          if (detail.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(detail,
                    style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
              ),
            ),
        ],
      ),
    );
  }
}
