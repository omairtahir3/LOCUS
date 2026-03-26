import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class ActivityFeedScreen extends StatelessWidget {
  const ActivityFeedScreen({super.key});

  static const List<Map<String, dynamic>> _mockActivities = [
    {'time': '08:15 AM', 'type': 'routine', 'title': 'Morning routine started', 'detail': 'Woke up and left bedroom', 'icon': Icons.coffee_outlined},
    {'time': '08:30 AM', 'type': 'medication', 'title': 'Medication taken', 'detail': 'Morning dose confirmed by camera', 'icon': Icons.monitor_heart_outlined},
    {'time': '09:00 AM', 'type': 'social', 'title': 'Social interaction', 'detail': 'Met with neighbor Mrs. Johnson', 'icon': Icons.psychology_outlined},
    {'time': '10:30 AM', 'type': 'movement', 'title': 'Walk detected', 'detail': '~2,400 steps in the garden', 'icon': Icons.directions_walk_outlined},
    {'time': '12:00 PM', 'type': 'routine', 'title': 'Lunch preparation', 'detail': 'Kitchen activity for 25 minutes', 'icon': Icons.coffee_outlined},
    {'time': '02:00 PM', 'type': 'rest', 'title': 'Afternoon rest', 'detail': 'Resting period - 1.5 hours', 'icon': Icons.dark_mode_outlined},
    {'time': '04:00 PM', 'type': 'anomaly', 'title': '⚠ Anomaly detected', 'detail': 'Unusual inactivity period', 'icon': Icons.monitor_heart_outlined},
  ];

  static const Map<String, Color> _typeColors = {
    'routine': AppColors.primary,
    'medication': AppColors.success,
    'social': AppColors.accent,
    'movement': AppColors.info,
    'rest': AppColors.textMuted,
    'anomaly': AppColors.warning,
  };

  static const List<Map<String, dynamic>> _insights = [
    {'label': 'Routine Adherence', 'value': 85, 'color': AppColors.primary},
    {'label': 'Social Activity', 'value': 60, 'color': AppColors.accent},
    {'label': 'Physical Activity', 'value': 72, 'color': AppColors.success},
    {'label': 'Sleep Quality', 'value': 90, 'color': AppColors.info},
  ];

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Activity Feed', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                SizedBox(height: 2),
                Text('Behavioral monitoring & analysis', style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
              ]),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(color: AppColors.primaryLight, borderRadius: BorderRadius.circular(20)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.shield_outlined, size: 12, color: AppColors.primaryDark),
                  const SizedBox(width: 4),
                  Text('Coming Soon', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.primaryDark)),
                ]),
              ),
            ],
          ),
          const SizedBox(height: 20),

          // Stat cards
          Row(
            children: [
              _statCard('4,200', 'Steps Today', Icons.directions_walk_outlined, AppColors.primary),
              const SizedBox(width: 10),
              _statCard('3', 'Social', Icons.psychology_outlined, AppColors.accent),
              const SizedBox(width: 10),
              _statCard('6.5h', 'Active Time', Icons.schedule_outlined, AppColors.success),
              const SizedBox(width: 10),
              _statCard('1', 'Anomalies', Icons.trending_up_outlined, AppColors.warning),
            ],
          ),
          const SizedBox(height: 20),

          // Timeline
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text("Today's Activity Timeline", style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                const SizedBox(height: 4),
                Text('Sample data — Module 1 backend required', style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
                const SizedBox(height: 16),
                ..._mockActivities.asMap().entries.map((entry) {
                  final i = entry.key;
                  final act = entry.value;
                  final color = _typeColors[act['type']] ?? AppColors.textMuted;
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Timeline dot and line
                      SizedBox(
                        width: 36,
                        child: Column(
                          children: [
                            Container(
                              width: 32,
                              height: 32,
                              decoration: BoxDecoration(
                                color: color.withValues(alpha: 0.12),
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Icon(act['icon'] as IconData, size: 16, color: color),
                            ),
                            if (i < _mockActivities.length - 1)
                              Container(width: 2, height: 32, color: AppColors.border),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Text(act['title'] as String, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                                  Text(act['time'] as String, style: const TextStyle(fontSize: 10, color: AppColors.textMuted)),
                                ],
                              ),
                              const SizedBox(height: 2),
                              Text(act['detail'] as String, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                            ],
                          ),
                        ),
                      ),
                    ],
                  );
                }),
              ],
            ),
          ),
          const SizedBox(height: 20),

          // Behavioral Insights
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Behavioral Insights', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                const SizedBox(height: 16),
                ..._insights.map((item) => Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: Column(
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(item['label'] as String, style: const TextStyle(fontSize: 13)),
                          Text('${item['value']}%', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                        ],
                      ),
                      const SizedBox(height: 6),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(
                          value: (item['value'] as int) / 100,
                          backgroundColor: AppColors.borderLight,
                          color: item['color'] as Color,
                          minHeight: 8,
                        ),
                      ),
                    ],
                  ),
                )),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _statCard(String value, String label, IconData icon, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withValues(alpha: 0.2)),
        ),
        child: Column(
          children: [
            Icon(icon, color: color, size: 18),
            const SizedBox(height: 6),
            Text(value, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: color)),
            Text(label, style: const TextStyle(fontSize: 9, color: AppColors.textSecondary), textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
