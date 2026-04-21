import 'dart:async';
import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => HomeScreenState();
}

class HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic>? _summary;
  List<dynamic> _schedule = [];
  bool _loading = true;

  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _loadData();
    _refreshTimer = Timer.periodic(const Duration(seconds: 10), (_) => _loadData());
  }

  void reload() => _loadData();

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadData() async {
    try {
      final results = await Future.wait([
        ApiService.getAdherenceSummary(),
        ApiService.getSchedule(),
      ]);
      setState(() {
        _summary = results[0] as Map<String, dynamic>;
        _schedule = results[1] as List<dynamic>;
        _loading = false;
      });
    } catch (e) {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final greeting = now.hour < 12 ? 'Good Morning' : now.hour < 17 ? 'Good Afternoon' : 'Good Evening';

    return RefreshIndicator(
      onRefresh: _loadData,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Greeting
            Text(greeting, style: TextStyle(fontSize: 14, color: AppColors.textSecondary, fontWeight: FontWeight.w500)),
            const SizedBox(height: 2),
            Text('Dashboard', style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
            const SizedBox(height: 24),

            // Stats cards
            _buildStatCards(),
            const SizedBox(height: 20),

            // Upcoming dose
            _buildUpcomingDose(),
            const SizedBox(height: 20),

            // Today's schedule
            _buildScheduleSection(),
          ],
        ),
      ),
    );
  }

  Widget _buildStatCards() {
    final taken = _summary?['taken'] ?? _summary?['counts']?['taken'] ?? 0;
    final missed = _summary?['missed'] ?? _summary?['counts']?['missed'] ?? 0;
    final adherence = _summary?['adherence_percentage'] ?? 0;

    return Row(
      children: [
        _statCard('Taken', '$taken', AppColors.success, Icons.check_circle_outline),
        const SizedBox(width: 12),
        _statCard('Missed', '$missed', AppColors.danger, Icons.cancel_outlined),
        const SizedBox(width: 12),
        _statCard('Adherence', '${adherence is num ? adherence.toStringAsFixed(0) : adherence}%', AppColors.primary, Icons.analytics_outlined),
      ],
    );
  }

  Widget _statCard(String label, String value, Color color, IconData icon) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: color.withAlpha(25),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, size: 18, color: color),
            ),
            const SizedBox(height: 10),
            Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
            Text(label, style: TextStyle(fontSize: 11, color: AppColors.textSecondary, fontWeight: FontWeight.w500)),
          ],
        ),
      ),
    );
  }

  Widget _buildUpcomingDose() {
    final upcoming = _schedule.where((s) => s['status'] == 'scheduled' || s['status'] == 'pending').toList();

    if (upcoming.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [AppColors.primary, AppColors.primaryDark]),
          borderRadius: BorderRadius.circular(16),
        ),
        child: const Row(
          children: [
            Icon(Icons.check_circle, color: Colors.white, size: 32),
            SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text("You're all caught up!", style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 16)),
                  Text('No pending medications', style: TextStyle(color: Colors.white70, fontSize: 13)),
                ],
              ),
            ),
          ],
        ),
      );
    }

    final next = upcoming.first;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(colors: [AppColors.primary, AppColors.primaryDark]),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Colors.white.withAlpha(40), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.medication_outlined, color: Colors.white, size: 28),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Next Dose', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                Text(next['medication_name'] ?? 'Medication', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 17)),
                Text('${next['dosage'] ?? ''} • ${next['scheduled_time'] ?? ''}',
                    style: const TextStyle(color: Colors.white70, fontSize: 13)),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
            child: Text(next['scheduled_time'] ?? '', style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700, fontSize: 14)),
          ),
        ],
      ),
    );
  }

  Widget _buildScheduleSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text("Today's Schedule", style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        if (_loading)
          const Center(child: CircularProgressIndicator())
        else if (_schedule.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(32),
            decoration: BoxDecoration(
              color: AppColors.surface, borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.border),
            ),
            child: Column(
              children: [
                Icon(Icons.medication_outlined, size: 40, color: AppColors.textMuted),
                const SizedBox(height: 8),
                Text('No medications today', style: TextStyle(color: AppColors.textSecondary)),
              ],
            ),
          )
        else
          ...List.generate(_schedule.length, (i) {
            final dose = _schedule[i];
            return _doseCard(dose);
          }),
      ],
    );
  }

  Widget _doseCard(Map<String, dynamic> dose) {
    final status = dose['status'] ?? 'scheduled';
    Color statusColor;
    IconData statusIcon;
    switch (status) {
      case 'taken':   statusColor = AppColors.success; statusIcon = Icons.check_circle; break;
      case 'missed':  statusColor = AppColors.danger; statusIcon = Icons.cancel; break;
      case 'snoozed': statusColor = AppColors.warning; statusIcon = Icons.snooze; break;
      default:        statusColor = AppColors.textMuted; statusIcon = Icons.schedule; break;
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: statusColor.withAlpha(25), borderRadius: BorderRadius.circular(10)),
            child: Icon(Icons.medication_outlined, color: statusColor, size: 20),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(dose['medication_name'] ?? 'Medication', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                const SizedBox(height: 2),
                Text('${dose['dosage'] ?? ''} • ${dose['scheduled_time'] ?? ''}',
                    style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
              ],
            ),
          ),
          if (status == 'needs_verification')
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                GestureDetector(
                  onTap: () => _logDose(dose, 'taken'),
                  child: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(color: AppColors.success.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                    child: const Icon(Icons.check, color: AppColors.success, size: 18),
                  ),
                ),
                const SizedBox(width: 8),
                GestureDetector(
                  onTap: () => _logDose(dose, 'missed'),
                  child: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(color: AppColors.danger.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                    child: const Icon(Icons.close, color: AppColors.danger, size: 18),
                  ),
                ),
              ],
            )
          else
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(color: statusColor.withAlpha(25), borderRadius: BorderRadius.circular(8)),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(statusIcon, size: 14, color: statusColor),
                  const SizedBox(width: 4),
                  Text(status.toUpperCase(), style: TextStyle(color: statusColor, fontSize: 10, fontWeight: FontWeight.w700)),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _logDose(Map<String, dynamic> dose, String status) async {
    try {
      final timeParts = (dose['scheduled_time'] as String).split(':');
      final now = DateTime.now();
      final dt = DateTime(now.year, now.month, now.day, int.parse(timeParts[0]), int.parse(timeParts[1]));
      
      await ApiService.recordDose(
        dose['medication_id'] ?? dose['_id'], 
        status,
        dt.toIso8601String()
      );
      _loadData();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Dose marked as $status'), backgroundColor: AppColors.primary),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed: $e'), backgroundColor: AppColors.danger),
        );
      }
    }
  }
}
