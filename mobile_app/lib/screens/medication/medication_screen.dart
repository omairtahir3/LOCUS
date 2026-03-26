import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/notification_service.dart';

class MedicationScreen extends StatefulWidget {
  const MedicationScreen({super.key});

  @override
  State<MedicationScreen> createState() => _MedicationScreenState();
}

class _MedicationScreenState extends State<MedicationScreen> with SingleTickerProviderStateMixin {
  late TabController _tabCtrl;
  List<dynamic> _schedule = [];
  List<dynamic> _history = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _tabCtrl = TabController(length: 3, vsync: this);
    _loadData();
  }

  Future<void> _loadData() async {
    try {
      final results = await Future.wait([
        ApiService.getSchedule(),
        ApiService.getDoseHistory(limit: 30),
      ]);
      setState(() {
        _schedule = results[0];
        _history = results[1];
        _loading = false;
      });
    } catch (e) {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          color: AppColors.surface,
          child: TabBar(
            controller: _tabCtrl,
            labelColor: AppColors.primary,
            unselectedLabelColor: AppColors.textMuted,
            indicatorColor: AppColors.primary,
            indicatorWeight: 3,
            tabs: const [
              Tab(text: 'Today', icon: Icon(Icons.today, size: 18)),
              Tab(text: 'All Meds', icon: Icon(Icons.medication, size: 18)),
              Tab(text: 'History', icon: Icon(Icons.history, size: 18)),
            ],
          ),
        ),
        Expanded(
          child: TabBarView(
            controller: _tabCtrl,
            children: [
              _buildTodayTab(),
              _buildAllMedsTab(),
              _buildHistoryTab(),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildTodayTab() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_schedule.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.medication_outlined, size: 56, color: AppColors.textMuted),
            const SizedBox(height: 12),
            Text('No medications scheduled today', style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _schedule.length,
        itemBuilder: (ctx, i) => _doseCard(_schedule[i]),
      ),
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

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: statusColor.withAlpha(25),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(Icons.medication, color: statusColor, size: 22),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(dose['medication_name'] ?? 'Medication',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                  const SizedBox(height: 3),
                  Text('${dose['dosage'] ?? ''} • ${dose['scheduled_time'] ?? ''}',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                ],
              ),
            ),
            if (status == 'scheduled' || status == 'pending')
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _actionBtn(Icons.check, AppColors.success, () => _logDose(dose, 'taken')),
                  const SizedBox(width: 6),
                  _actionBtn(Icons.snooze, AppColors.warning, () => _logDose(dose, 'snoozed')),
                  const SizedBox(width: 6),
                  _actionBtn(Icons.close, AppColors.danger, () => _logDose(dose, 'missed')),
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
      ),
    );
  }

  Widget _actionBtn(IconData icon, Color color, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(color: color.withAlpha(25), borderRadius: BorderRadius.circular(8)),
        child: Icon(icon, size: 18, color: color),
      ),
    );
  }

  Future<void> _logDose(Map<String, dynamic> dose, String status) async {
    try {
      await ApiService.recordDose(
        dose['medication_id'] ?? dose['_id'],
        status,
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

  Widget _buildAllMedsTab() {
    // Unique medications from schedule
    final meds = <String, Map<String, dynamic>>{};
    for (final s in _schedule) {
      final name = s['medication_name'] ?? 'Unknown';
      meds[name] = s;
    }

    if (meds.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.medication_liquid, size: 56, color: AppColors.textMuted),
            const SizedBox(height: 12),
            Text('No medications found', style: TextStyle(color: AppColors.textSecondary)),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: () => _showAddMedDialog(),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('Add Medication'),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          ...meds.values.map((med) => Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: ListTile(
              leading: Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: AppColors.primaryLight, borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.medication, color: AppColors.primary, size: 20),
              ),
              title: Text(med['medication_name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text(med['dosage'] ?? '', style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
              trailing: const Icon(Icons.chevron_right, color: AppColors.textMuted),
            ),
          )),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () => _showAddMedDialog(),
            icon: const Icon(Icons.add),
            label: const Text('Add Medication'),
          ),
        ],
      ),
    );
  }

  void _showAddMedDialog() {
    final nameCtrl = TextEditingController();
    final dosageCtrl = TextEditingController();
    final instrCtrl = TextEditingController();
    final times = <TimeOfDay>[];
    String frequency = 'daily';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Padding(
          padding: EdgeInsets.fromLTRB(24, 24, 24, MediaQuery.of(ctx).viewInsets.bottom + 24),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Add Medication', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                const SizedBox(height: 20),
                TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Medication Name')),
                const SizedBox(height: 12),
                TextField(controller: dosageCtrl, decoration: const InputDecoration(labelText: 'Dosage (e.g. 500mg)')),
                const SizedBox(height: 12),
                TextField(controller: instrCtrl, decoration: const InputDecoration(labelText: 'Instructions (optional)')),
                const SizedBox(height: 16),

                // Frequency selector
                const Text('Frequency', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  children: ['daily', 'weekly', 'as_needed'].map((f) =>
                    ChoiceChip(
                      label: Text(f.replaceAll('_', ' ').toUpperCase(), style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600,
                        color: frequency == f ? Colors.white : AppColors.textSecondary)),
                      selected: frequency == f,
                      onSelected: (_) => setSheetState(() => frequency = f),
                      selectedColor: AppColors.primary,
                      backgroundColor: AppColors.borderLight,
                      side: BorderSide.none,
                      visualDensity: VisualDensity.compact,
                    ),
                  ).toList(),
                ),
                const SizedBox(height: 16),

                // Scheduled times
                Row(
                  children: [
                    const Expanded(child: Text('Scheduled Times', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
                    TextButton.icon(
                      onPressed: () async {
                        final picked = await showTimePicker(
                          context: ctx,
                          initialTime: TimeOfDay.now(),
                          builder: (context, child) => MediaQuery(
                            data: MediaQuery.of(context).copyWith(alwaysUse24HourFormat: false),
                            child: child!,
                          ),
                        );
                        if (picked != null) {
                          setSheetState(() => times.add(picked));
                        }
                      },
                      icon: const Icon(Icons.add_alarm, size: 18),
                      label: const Text('Add Time', style: TextStyle(fontSize: 12)),
                    ),
                  ],
                ),
                if (times.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text('Tap "Add Time" to set when to take this medication',
                        style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  )
                else
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: times.asMap().entries.map((e) {
                      final t = e.value;
                      final label = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
                      return Chip(
                        label: Text(label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                        avatar: const Icon(Icons.access_time, size: 16),
                        deleteIcon: const Icon(Icons.close, size: 16),
                        onDeleted: () => setSheetState(() => times.removeAt(e.key)),
                        backgroundColor: AppColors.primaryLight,
                        side: BorderSide.none,
                      );
                    }).toList(),
                  ),
                const SizedBox(height: 20),

                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: (nameCtrl.text.isEmpty || dosageCtrl.text.isEmpty || times.isEmpty) ? null : () async {
                      final timeStrings = times.map((t) =>
                        '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}'
                      ).toList();
                      try {
                        final res = await ApiService.createMedication(
                          name: nameCtrl.text.trim(),
                          dosage: dosageCtrl.text.trim(),
                          scheduledTimes: timeStrings,
                          frequency: frequency,
                          instructions: instrCtrl.text.trim().isEmpty ? null : instrCtrl.text.trim(),
                        );
                        // Schedule local notification reminders
                        await NotificationService.scheduleMedicationTimes(
                          medicationName: nameCtrl.text.trim(),
                          dosage: dosageCtrl.text.trim(),
                          times: times,
                        );
                        Navigator.pop(ctx);
                        _loadData();
                        if (mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text('${nameCtrl.text} added successfully!'), backgroundColor: AppColors.success),
                          );
                        }
                      } catch (e) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Error: $e'), backgroundColor: AppColors.danger),
                        );
                      }
                    },
                    child: const Text('Add Medication'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHistoryTab() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_history.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.history, size: 56, color: AppColors.textMuted),
            const SizedBox(height: 12),
            Text('No history yet', style: TextStyle(color: AppColors.textSecondary)),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: _history.length,
        itemBuilder: (ctx, i) {
          final h = _history[i] as Map<String, dynamic>;
          final status = h['status'] ?? 'unknown';
          Color color;
          IconData icon;
          switch (status) {
            case 'taken':   color = AppColors.success; icon = Icons.check_circle; break;
            case 'missed':  color = AppColors.danger; icon = Icons.cancel; break;
            case 'snoozed': color = AppColors.warning; icon = Icons.snooze; break;
            default:        color = AppColors.textMuted; icon = Icons.circle_outlined; break;
          }

          return Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              leading: Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: color.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                child: Icon(icon, color: color, size: 18),
              ),
              title: Text(
                h['medication_name'] ?? h['medication_id']?['name'] ?? 'Medication',
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
              ),
              subtitle: Text(
                _formatDate(h['scheduled_time'] ?? h['createdAt'] ?? ''),
                style: TextStyle(color: AppColors.textSecondary, fontSize: 11),
              ),
              trailing: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(color: color.withAlpha(25), borderRadius: BorderRadius.circular(6)),
                child: Text(status.toUpperCase(), style: TextStyle(color: color, fontSize: 9, fontWeight: FontWeight.w700)),
              ),
            ),
          );
        },
      ),
    );
  }

  String _formatDate(String isoDate) {
    try {
      final dt = DateTime.parse(isoDate);
      return '${dt.day}/${dt.month}/${dt.year} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return isoDate;
    }
  }

  @override
  void dispose() {
    _tabCtrl.dispose();
    super.dispose();
  }
}
