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
    final userName = ApiService.user?['name']?.toString().split(' ').first ?? 'Caregiver';

    if (_loading && _users.isEmpty) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary));
    }

    final totalUsers = _users.length;
    final avg = _summaries.values.fold<double>(0, (sum, s) {
      return sum + ((s?['today_adherence']?['adherence_percentage'] ?? 0) as num).toDouble();
    }) / (totalUsers > 0 ? totalUsers : 1);
    final totalMissed = _summaries.values.fold<int>(0, (sum, s) {
      return sum + ((s?['today_adherence']?['missed'] ?? 0) as num).toInt();
    });

    return RefreshIndicator(
      onRefresh: _loadData,
      color: AppColors.primary,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Hi, $userName! 👋', style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: -0.5)),
            const SizedBox(height: 4),
            Text('Your care network is active.', style: TextStyle(color: AppColors.textSecondary, fontSize: 15)),
            const SizedBox(height: 32),

            // ── Premium Stats ──
            Row(
              children: [
                _premiumStatCard('Adherence', '${avg.toStringAsFixed(0)}%', Icons.check_circle, AppColors.success, context),
                const SizedBox(width: 16),
                _premiumStatCard('Alerts', '${_notifications.length}', Icons.notifications_active, AppColors.warning, context),
              ],
            ),
            const SizedBox(height: 16),
            _wideStatCard('Monitoring $totalUsers family members', Icons.people, AppColors.primary),
            const SizedBox(height: 40),

            // ── Family grid ──
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Family Status', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                TextButton(
                  onPressed: () {},
                  child: const Text('See All', style: TextStyle(fontWeight: FontWeight.w700)),
                ),
              ],
            ),
            const SizedBox(height: 12),

            if (_users.isEmpty)
              _emptyState(Icons.family_restroom, 'No family connected')
            else
              ..._users.asMap().entries.map((e) => _memberCard(e.key, e.value)),

            const SizedBox(height: 40),
            const Text('Recent Activity', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
            const SizedBox(height: 16),

            if (_notifications.isEmpty)
              _emptyState(Icons.notifications_none, 'No recent activity')
            else
              ..._notifications.map((n) => _notificationCard(n)),
          ],
        ),
      ),
    );
  }

  Widget _premiumStatCard(String label, String value, IconData icon, Color color, BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(28),
          border: Border.all(color: AppColors.border),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.03), blurRadius: 10, offset: const Offset(0, 4))],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(14)),
              child: Icon(icon, color: color, size: 22),
            ),
            const SizedBox(height: 20),
            Text(value, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: -1)),
            Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.textSecondary, letterSpacing: 0.5)),
          ],
        ),
      ),
    );
  }

  Widget _wideStatCard(String label, IconData icon, Color color) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: color.withValues(alpha: 0.1)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(width: 12),
          Text(label, style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 14)),
        ],
      ),
    );
  }

  Widget _memberCard(int i, dynamic u) {
    final s = _summaries[u['_id']];
    final adh = (s?['today_adherence']?['adherence_percentage'] ?? 0) as num;
    final colors = [AppColors.primary, AppColors.accent, const Color(0xFFEC4899), const Color(0xFFF59E0B)];
    
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 24,
            backgroundColor: colors[i % colors.length],
            child: Text(u['name']?.toString().substring(0, 1).toUpperCase() ?? '?', 
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 18)),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(u['name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                const SizedBox(height: 2),
                Text(u['email'] ?? '', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('${adh.toStringAsFixed(0)}%', 
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: adh >= 80 ? AppColors.success : AppColors.warning)),
              const Text('Adherence', style: TextStyle(fontSize: 10, color: AppColors.textMuted, fontWeight: FontWeight.w700)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _notificationCard(Map<String, dynamic> n) {
    final type = n['type'] ?? 'system';
    IconData icon = Icons.notifications;
    Color color = AppColors.info;
    if (type == 'missed_dose') { icon = Icons.medication; color = AppColors.danger; }
    else if (type == 'emergency') { icon = Icons.warning; color = AppColors.warning; }

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(16)),
            child: Icon(icon, color: color, size: 20),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(n['title'] ?? '', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
                const SizedBox(height: 4),
                Text(n['message'] ?? '', style: TextStyle(color: AppColors.textSecondary, fontSize: 12, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _emptyState(IconData icon, String text) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(40),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(24), border: Border.all(color: AppColors.border)),
      child: Column(
        children: [
          Icon(icon, size: 40, color: AppColors.textMuted.withValues(alpha: 0.5)),
          const SizedBox(height: 16),
          Text(text, style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}
