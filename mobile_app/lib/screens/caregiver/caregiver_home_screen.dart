import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class CaregiverHomeScreen extends StatefulWidget {
  const CaregiverHomeScreen({super.key});

  @override
  State<CaregiverHomeScreen> createState() => _CaregiverHomeScreenState();
}

class _CaregiverHomeScreenState extends State<CaregiverHomeScreen> {
  List<dynamic> _users = [];
  Map<String, dynamic> _summaries = {};
  List<dynamic> _notifications = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      final users = await ApiService.getMonitoredUsers();
      final summaries = <String, dynamic>{};
      for (final u in users) {
        try {
          summaries[u['_id']] = await ApiService.getUserSummary(u['_id']);
        } catch (_) {}
      }
      // Load recent notifications
      List<dynamic> notifs = [];
      try {
        notifs = await ApiService.getNotifications(limit: 5);
      } catch (_) {}
      setState(() { _users = users; _summaries = summaries; _notifications = notifs; });
    } catch (_) {} finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final userName = ApiService.user?['name']?.toString().split(' ').first ?? 'there';

    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    final totalUsers = _users.length;
    final avg = _summaries.values.fold<double>(0, (sum, s) {
      return sum + ((s?['today_adherence']?['adherence_percentage'] ?? 0) as num).toDouble();
    }) / (totalUsers > 0 ? totalUsers : 1);
    final totalMissed = _summaries.values.fold<int>(0, (sum, s) {
      return sum + ((s?['today_adherence']?['missed'] ?? 0) as num).toInt();
    });
    final totalAlerts = _notifications.length;

    return RefreshIndicator(
      onRefresh: _loadData,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Hi, $userName 👋', style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text('Monitoring $totalUsers family member${totalUsers == 1 ? '' : 's'}', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
            const SizedBox(height: 20),

            // ── Stat cards (2 rows of 2) ──
            Row(
              children: [
                _statCard('Family Members', '$totalUsers', Icons.people_outline, AppColors.primary),
                const SizedBox(width: 12),
                _statCard('Avg Adherence', '${avg.toStringAsFixed(0)}%', Icons.check_circle_outline, AppColors.success),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                _statCard('Missed Today', '$totalMissed', Icons.warning_amber_outlined, AppColors.danger),
                const SizedBox(width: 12),
                _statCard('Pending Alerts', '$totalAlerts', Icons.notifications_active_outlined, AppColors.warning),
              ],
            ),
            const SizedBox(height: 24),

            // ── Family members list ──
            const Text('Your Family', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),

            if (_users.isEmpty)
              Container(
                padding: const EdgeInsets.all(32),
                decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                child: Column(
                  children: [
                    Icon(Icons.family_restroom, size: 48, color: AppColors.textMuted),
                    const SizedBox(height: 12),
                    Text('No family members yet', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                    const SizedBox(height: 4),
                    Text('Ask your elderly family members to link you from their app', style: TextStyle(fontSize: 12, color: AppColors.textMuted), textAlign: TextAlign.center),
                  ],
                ),
              )
            else
              ..._users.asMap().entries.map((e) {
                final i = e.key;
                final u = e.value;
                final s = _summaries[u['_id']];
                final adh = s?['today_adherence']?['adherence_percentage'];
                final colors = [AppColors.primary, const Color(0xFF6366F1), const Color(0xFFEC4899), const Color(0xFFF59E0B)];
                return Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: AppColors.border)),
                  child: ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    leading: CircleAvatar(
                      backgroundColor: colors[i % colors.length],
                      child: Text(u['name']?.toString().substring(0, 1).toUpperCase() ?? '?', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                    ),
                    title: Text(u['name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                    subtitle: Text(u['email'] ?? '', style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
                    trailing: adh != null
                        ? Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: (adh as num) >= 80 ? AppColors.success.withValues(alpha: 0.1) : AppColors.danger.withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: Text('${adh.toStringAsFixed(0)}%', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: adh >= 80 ? AppColors.success : AppColors.danger)),
                          )
                        : null,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                );
              }),

            // ── Recent Alerts ──
            const SizedBox(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Recent Alerts', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                Text('${_notifications.length} notifications', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ],
            ),
            const SizedBox(height: 12),

            if (_notifications.isEmpty)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(32),
                decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: AppColors.border)),
                child: Column(
                  children: [
                    Icon(Icons.notifications_none, size: 40, color: AppColors.textMuted),
                    const SizedBox(height: 8),
                    Text('All clear', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                    const SizedBox(height: 4),
                    Text('No new notifications at the moment.', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  ],
                ),
              )
            else
              ..._notifications.map((n) => _notificationCard(n)),
          ],
        ),
      ),
    );
  }

  Widget _notificationCard(Map<String, dynamic> n) {
    final type = n['type'] ?? 'system';
    Color iconBg;
    Color iconColor;
    IconData icon;

    switch (type) {
      case 'missed_dose':
        iconBg = AppColors.dangerLight;
        iconColor = AppColors.danger;
        icon = Icons.medication_outlined;
        break;
      case 'emergency':
        iconBg = AppColors.warningLight;
        iconColor = AppColors.warning;
        icon = Icons.warning_amber;
        break;
      case 'dose_confirmed':
        iconBg = AppColors.successLight;
        iconColor = AppColors.success;
        icon = Icons.check_circle_outline;
        break;
      default:
        iconBg = AppColors.infoLight;
        iconColor = AppColors.info;
        icon = Icons.notifications_outlined;
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: n['is_read'] == true ? AppColors.surface : iconBg.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: iconBg, borderRadius: BorderRadius.circular(10)),
            child: Icon(icon, size: 18, color: iconColor),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(n['title'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                Text(n['message'] ?? '', style: TextStyle(fontSize: 11, color: AppColors.textSecondary), maxLines: 2, overflow: TextOverflow.ellipsis),
                const SizedBox(height: 2),
                Text(_formatTime(n['createdAt']), style: TextStyle(fontSize: 10, color: AppColors.textMuted)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _statCard(String label, String value, IconData icon, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.2)),
        ),
        child: Column(
          children: [
            Icon(icon, color: color, size: 22),
            const SizedBox(height: 8),
            Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: color)),
            Text(label, style: TextStyle(fontSize: 10, color: AppColors.textSecondary), textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }

  String _formatTime(String? raw) {
    if (raw == null) return '—';
    try { return DateTime.parse(raw).toLocal().toString().substring(0, 16); } catch (_) { return raw; }
  }
}
