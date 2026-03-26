import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class ActivityScreen extends StatelessWidget {
  const ActivityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Coming soon badge
          Row(
            children: [
              const Expanded(
                child: Text('Activity Summary', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(colors: [AppColors.accent, AppColors.primary]),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.rocket_launch, size: 12, color: Colors.white),
                    SizedBox(width: 4),
                    Text('Coming Soon', style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w700)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text('Daily insights & behavioral patterns', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
          const SizedBox(height: 20),

          // Stats
          Row(
            children: [
              _metricCard('Steps', '4,200', Icons.directions_walk, AppColors.info),
              const SizedBox(width: 12),
              _metricCard('Interactions', '3', Icons.people_outline, AppColors.accent),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              _metricCard('Active Time', '6.5h', Icons.timer_outlined, AppColors.success),
              const SizedBox(width: 12),
              _metricCard('Anomalies', '1', Icons.warning_amber, AppColors.warning),
            ],
          ),
          const SizedBox(height: 24),

          // Timeline
          const Text('Daily Timeline', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),

          ..._mockTimeline.map((item) => _timelineItem(item)),

          const SizedBox(height: 24),

          // Insights
          const Text('Behavioral Insights', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),

          _insightBar('Routine Adherence', 0.85, AppColors.primary),
          _insightBar('Social Activity', 0.60, AppColors.accent),
          _insightBar('Physical Activity', 0.72, AppColors.success),
          _insightBar('Sleep Quality', 0.90, AppColors.info),
        ],
      ),
    );
  }

  static final _mockTimeline = [
    {'time': '08:15 AM', 'title': 'Morning routine started', 'desc': 'Woke up and left bedroom', 'icon': Icons.wb_sunny_outlined, 'color': AppColors.warning},
    {'time': '08:30 AM', 'title': 'Medication taken', 'desc': 'Morning dose confirmed', 'icon': Icons.medication_outlined, 'color': AppColors.success},
    {'time': '09:00 AM', 'title': 'Social interaction', 'desc': 'Met with neighbor', 'icon': Icons.people_outline, 'color': AppColors.accent},
    {'time': '10:30 AM', 'title': 'Walk detected', 'desc': '~2,400 steps in garden', 'icon': Icons.directions_walk, 'color': AppColors.info},
    {'time': '12:00 PM', 'title': 'Lunch preparation', 'desc': 'Kitchen activity — 25 min', 'icon': Icons.restaurant_outlined, 'color': AppColors.primary},
    {'time': '02:00 PM', 'title': 'Afternoon rest', 'desc': 'Resting period — 1.5 hours', 'icon': Icons.hotel_outlined, 'color': AppColors.textMuted},
    {'time': '04:00 PM', 'title': 'Anomaly detected', 'desc': 'Unusual inactivity period', 'icon': Icons.warning_amber, 'color': AppColors.warning},
  ];

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
              decoration: BoxDecoration(color: color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(width: 12),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(value, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
                Text(label, style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _timelineItem(Map<String, dynamic> item) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 70,
            child: Text(item['time'] as String, style: TextStyle(fontSize: 11, color: AppColors.textMuted, fontWeight: FontWeight.w600)),
          ),
          Column(
            children: [
              Container(
                width: 36, height: 36,
                decoration: BoxDecoration(
                  color: (item['color'] as Color).withAlpha(25),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(item['icon'] as IconData, size: 16, color: item['color'] as Color),
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
                  Text(item['title'] as String, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  const SizedBox(height: 2),
                  Text(item['desc'] as String, style: TextStyle(color: AppColors.textSecondary, fontSize: 11)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _insightBar(String label, double value, Color color) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              Text('${(value * 100).toInt()}%', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: color)),
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
        ],
      ),
    );
  }
}
