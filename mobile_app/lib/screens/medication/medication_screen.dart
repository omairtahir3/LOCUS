import 'dart:async';
import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/notification_service.dart';

class MedicationScreen extends StatefulWidget {
  const MedicationScreen({super.key});

  @override
  State<MedicationScreen> createState() => MedicationScreenState();
}

class MedicationScreenState extends State<MedicationScreen> with SingleTickerProviderStateMixin {
  late TabController _tabCtrl;
  List<dynamic> _schedule = [];
  List<dynamic> _medications = [];
  List<dynamic> _history = [];
  bool _loading = true;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    _tabCtrl = TabController(length: 3, vsync: this);
    _loadData();
    _refreshTimer = Timer.periodic(const Duration(seconds: 10), (_) => _loadData());
  }

  /// Called by MainShell when user switches to this tab
  void reload() {
    _loadData();
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _tabCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    try {
      final results = await Future.wait([
        ApiService.getSchedule(),
        ApiService.getMedications(),
        ApiService.getDoseHistory(limit: 30),
      ]);
      if (mounted) {
        setState(() {
          _schedule = results[0];
          _medications = results[1];
          _history = results[2];
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _loading = false);
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

  // ─── TODAY TAB ──────────────────────────────────────────────────────────

  Widget _buildTodayTab() {
    if (_loading) return const Center(child: CircularProgressIndicator());

    // No medications exist at all
    if (_medications.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.medication_outlined, size: 56, color: AppColors.textMuted),
            const SizedBox(height: 12),
            Text('No medications added yet',
                style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text('Go to the "Add Medicine" tab to add your medications',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
          ],
        ),
      );
    }

    // Medications exist but none scheduled today
    if (_schedule.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.event_available, size: 56, color: AppColors.success),
            const SizedBox(height: 12),
            Text('No medicines scheduled for today',
                style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
          ],
        ),
      );
    }

    // Check if all doses are completed (taken/missed/snoozed)
    final pending = _schedule.where((d) {
      final s = d['status'] ?? 'scheduled';
      return s == 'scheduled' || s == 'pending';
    }).toList();

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Show pending doses first
          if (pending.isNotEmpty) ...[
            _sectionHeader('Upcoming', Icons.schedule, AppColors.primary),
            const SizedBox(height: 8),
            ...pending.map((dose) => _doseCard(dose as Map<String, dynamic>)),
            const SizedBox(height: 16),
          ],

          // Completed doses are now removed instantly and only show in History tab

          // If no more pending, show completion message
          if (pending.isEmpty) ...[
            const SizedBox(height: 24),
            Center(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                decoration: BoxDecoration(
                  color: AppColors.success.withAlpha(20),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.success.withAlpha(40)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.check_circle, color: AppColors.success, size: 20),
                    const SizedBox(width: 10),
                    Text('No more medicines scheduled for today',
                        style: TextStyle(color: AppColors.success, fontWeight: FontWeight.w600, fontSize: 13)),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _sectionHeader(String title, IconData icon, Color color) {
    return Row(
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 6),
        Text(title, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: color)),
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
      default:        statusColor = AppColors.primary; statusIcon = Icons.schedule; break;
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
                  Text(dose['medication_name'] ?? dose['name'] ?? 'Medication',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                  const SizedBox(height: 3),
                  Text('${dose['dosage'] ?? ''} • ${dose['scheduled_time'] ?? ''}',
                      style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                ],
              ),
            ),
            if (status == 'needs_verification')
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
            else if (status == 'scheduled' || status == 'pending')
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(color: AppColors.primary.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.camera_alt, size: 14, color: AppColors.primary),
                    const SizedBox(width: 4),
                    Text('PENDING CAMERA VERIFICATION', style: TextStyle(color: AppColors.primary, fontSize: 9, fontWeight: FontWeight.w800)),
                  ],
                ),
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
      // Must pass ISO format date string for today with the scheduled time. 
      // Fortunately getSchedule returns 'scheduled_time' like "08:00". Let's convert to ISO today String
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

  // ─── ADD MEDICINE TAB (was "All Meds") ─────────────────────────────────

  Widget _buildAllMedsTab() {
    if (_loading) return const Center(child: CircularProgressIndicator());

    return RefreshIndicator(
      onRefresh: _loadData,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // Add new medication button — always at top
          Card(
            color: AppColors.primaryLight,
            margin: const EdgeInsets.only(bottom: 16),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => _showAddEditMedDialog(),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(color: AppColors.primary.withAlpha(30), borderRadius: BorderRadius.circular(12)),
                      child: const Icon(Icons.add, color: AppColors.primary, size: 22),
                    ),
                    const SizedBox(width: 14),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Add New Medicine', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                          SizedBox(height: 2),
                          Text('Set name, dosage, times & frequency', style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                        ],
                      ),
                    ),
                    const Icon(Icons.arrow_forward_ios, size: 14, color: AppColors.textMuted),
                  ],
                ),
              ),
            ),
          ),

          // Existing medications
          if (_medications.isEmpty)
            Center(
              child: Padding(
                padding: const EdgeInsets.only(top: 40),
                child: Column(
                  children: [
                    Icon(Icons.medication_liquid, size: 56, color: AppColors.textMuted),
                    const SizedBox(height: 12),
                    Text('No medicines added yet', style: TextStyle(color: AppColors.textSecondary)),
                    const SizedBox(height: 4),
                    Text('Tap the button above to add your first medicine',
                        style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                  ],
                ),
              ),
            )
          else ...[
            _sectionHeader('Your Medicines', Icons.medication, AppColors.textSecondary),
            const SizedBox(height: 8),
            ..._medications.map((med) {
              final timesRaw = med['scheduled_times'] as List<dynamic>? ?? [];
              final timesStr = timesRaw.join(', ');
              final freq = (med['frequency'] ?? 'daily').toString().replaceAll('_', ' ');

              return Card(
                margin: const EdgeInsets.only(bottom: 10),
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => _showAddEditMedDialog(existingMed: med),
                  onLongPress: () => _confirmDeleteMed(med),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(color: AppColors.primaryLight, borderRadius: BorderRadius.circular(10)),
                          child: const Icon(Icons.medication, color: AppColors.primary, size: 20),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(med['name'] ?? med['medication_name'] ?? '',
                                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                              const SizedBox(height: 3),
                              Text('${med['dosage'] ?? ''} • $freq',
                                  style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
                              if (timesStr.isNotEmpty) ...[
                                const SizedBox(height: 2),
                                Text('⏰ $timesStr',
                                    style: TextStyle(color: AppColors.textMuted, fontSize: 11)),
                              ],
                            ],
                          ),
                        ),
                        const Icon(Icons.edit_outlined, color: AppColors.textMuted, size: 18),
                      ],
                    ),
                  ),
                ),
              );
            }),
          ],
        ],
      ),
    );
  }

  // ─── DELETE ─────────────────────────────────────────────────────────────

  Future<void> _confirmDeleteMed(Map<String, dynamic> med) async {
    final medName = med['medication_name'] ?? med['name'] ?? 'Medication';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Medication'),
        content: Text('Remove "$medName"? This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      try {
        await ApiService.deleteMedication(med['medication_id'] ?? med['_id'] ?? med['id'] ?? '');
        _loadData();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('$medName removed'), backgroundColor: AppColors.success),
          );
        }
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Error: $e'), backgroundColor: AppColors.danger),
          );
        }
      }
    }
  }

  // ─── ADD / EDIT DIALOG ─────────────────────────────────────────────────

  void _showAddEditMedDialog({Map<String, dynamic>? existingMed}) {
    final isEdit = existingMed != null;
    final nameCtrl = TextEditingController(
      text: isEdit ? (existingMed['medication_name'] ?? existingMed['name'] ?? '') : '',
    );
    final dosageCtrl = TextEditingController(text: isEdit ? existingMed['dosage'] ?? '' : '');
    final instrCtrl = TextEditingController(text: isEdit ? existingMed['instructions'] ?? '' : '');
    final times = <TimeOfDay>[];
    String frequency = isEdit ? (existingMed['frequency'] ?? 'daily') : 'daily';
    List<int> selectedDays = [];

    // Parse existing scheduled times
    if (isEdit) {
      final timesArray = existingMed['scheduled_times'] as List<dynamic>?;
      if (timesArray != null && timesArray.isNotEmpty) {
        for (final t in timesArray) {
          final parts = t.toString().split(':');
          if (parts.length >= 2) {
            times.add(TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])));
          }
        }
      } else if (existingMed['scheduled_time'] != null) {
        final parts = existingMed['scheduled_time'].toString().split(':');
        if (parts.length >= 2) {
          times.add(TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])));
        }
      }
      if (existingMed['days_of_week'] != null) {
        selectedDays = List<int>.from(existingMed['days_of_week']);
      }
    }

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
                Text(isEdit ? 'Edit Medicine' : 'Add Medicine',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                const SizedBox(height: 20),
                TextField(controller: nameCtrl, decoration: const InputDecoration(labelText: 'Medicine Name', hintText: 'e.g. Paracetamol')),
                const SizedBox(height: 12),
                TextField(controller: dosageCtrl, decoration: const InputDecoration(labelText: 'Dosage', hintText: 'e.g. 500mg')),
                const SizedBox(height: 12),
                TextField(controller: instrCtrl, decoration: const InputDecoration(labelText: 'Instructions (optional)', hintText: 'e.g. Take after meals')),
                const SizedBox(height: 16),

                // Frequency
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

                // Weekly day picker
                if (frequency == 'weekly') ...[
                  const Text('Days of Week', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    children: [
                      {'label': 'Mon', 'value': 0}, {'label': 'Tue', 'value': 1},
                      {'label': 'Wed', 'value': 2}, {'label': 'Thu', 'value': 3},
                      {'label': 'Fri', 'value': 4}, {'label': 'Sat', 'value': 5},
                      {'label': 'Sun', 'value': 6},
                    ].map((d) => FilterChip(
                      label: Text(d['label'] as String, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600,
                        color: selectedDays.contains(d['value']) ? Colors.white : AppColors.textSecondary)),
                      selected: selectedDays.contains(d['value']),
                      onSelected: (sel) => setSheetState(() {
                        if (sel) selectedDays.add(d['value'] as int);
                        else selectedDays.remove(d['value']);
                      }),
                      selectedColor: AppColors.primary,
                      backgroundColor: AppColors.borderLight,
                      side: BorderSide.none,
                      visualDensity: VisualDensity.compact,
                      checkmarkColor: Colors.white,
                    )).toList(),
                  ),
                  const SizedBox(height: 16),
                ],

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
                        if (picked != null) setSheetState(() => times.add(picked));
                      },
                      icon: const Icon(Icons.add_alarm, size: 18),
                      label: const Text('Add Time', style: TextStyle(fontSize: 12)),
                    ),
                  ],
                ),
                if (times.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text('Tap "Add Time" to set when to take this medicine',
                        style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                  )
                else
                  Wrap(
                    spacing: 8, runSpacing: 8,
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

                // Save / Delete buttons
                Row(
                  children: [
                    if (isEdit) ...[
                      Expanded(
                        flex: 1,
                        child: OutlinedButton(
                          onPressed: () {
                            Navigator.pop(ctx);
                            _confirmDeleteMed(existingMed);
                          },
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.danger,
                            side: BorderSide(color: AppColors.danger.withAlpha(100)),
                          ),
                          child: const Text('Delete'),
                        ),
                      ),
                      const SizedBox(width: 10),
                    ],
                    Expanded(
                      flex: 2,
                      child: ElevatedButton(
                        onPressed: (nameCtrl.text.isEmpty || dosageCtrl.text.isEmpty || times.isEmpty) ? null : () async {
                          final timeStrings = times.map((t) =>
                            '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}'
                          ).toList();
                          try {
                            if (isEdit) {
                              final medId = existingMed['medication_id'] ?? existingMed['_id'] ?? existingMed['id'] ?? '';
                              await ApiService.updateMedication(
                                id: medId,
                                name: nameCtrl.text.trim(),
                                dosage: dosageCtrl.text.trim(),
                                scheduledTimes: timeStrings,
                                frequency: frequency,
                                instructions: instrCtrl.text.trim().isEmpty ? null : instrCtrl.text.trim(),
                                daysOfWeek: frequency == 'weekly' ? selectedDays : null,
                              );
                            } else {
                              await ApiService.createMedication(
                                name: nameCtrl.text.trim(),
                                dosage: dosageCtrl.text.trim(),
                                scheduledTimes: timeStrings,
                                frequency: frequency,
                                instructions: instrCtrl.text.trim().isEmpty ? null : instrCtrl.text.trim(),
                                daysOfWeek: frequency == 'weekly' ? selectedDays : null,
                              );
                              await NotificationService.scheduleMedicationTimes(
                                medicationName: nameCtrl.text.trim(),
                                dosage: dosageCtrl.text.trim(),
                                times: times,
                              );
                            }
                            Navigator.pop(ctx);
                            _loadData();
                            if (mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(
                                  content: Text(isEdit ? '${nameCtrl.text} updated!' : '${nameCtrl.text} added!'),
                                  backgroundColor: AppColors.success,
                                ),
                              );
                            }
                          } catch (e) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(content: Text('Error: $e'), backgroundColor: AppColors.danger),
                            );
                          }
                        },
                        child: Text(isEdit ? 'Save Changes' : 'Add Medicine'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ─── HISTORY TAB ───────────────────────────────────────────────────────

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
            const SizedBox(height: 4),
            Text('Taken and missed doses will appear here',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
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
      if (!isoDate.endsWith('Z') && isoDate.length >= 10) {
        isoDate = isoDate + 'Z';
      }
      final dt = DateTime.parse(isoDate).toLocal();
      return '${dt.day}/${dt.month}/${dt.year} ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return isoDate;
    }
  }
}
