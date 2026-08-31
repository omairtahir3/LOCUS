import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

import '../../services/selected_user_service.dart';

class CaregiverMedicationsScreen extends StatefulWidget {
  const CaregiverMedicationsScreen({super.key});

  @override
  State<CaregiverMedicationsScreen> createState() => _CaregiverMedicationsScreenState();
}

class _CaregiverMedicationsScreenState extends State<CaregiverMedicationsScreen> {
  List<dynamic> _schedule = [];
  List<dynamic> _history = [];
  bool _loadingData = false;

  void _onSelectedUserChanged() {
    if (mounted) {
      setState(() {});
      _loadMedData();
    }
  }

  @override
  void initState() {
    super.initState();
    SelectedUserService().addListener(_onSelectedUserChanged);
    _loadMedData();
  }

  @override
  void dispose() {
    SelectedUserService().removeListener(_onSelectedUserChanged);
    super.dispose();
  }

  String? get _selectedUser => SelectedUserService().selectedUser?['_id'];

  Future<void> _loadMedData() async {
    if (_selectedUser == null) {
      if (mounted) setState(() { _schedule = []; _history = []; });
      return;
    }
    setState(() => _loadingData = true);
    try {
      final schedule = await ApiService.getSchedule(userId: _selectedUser);
      final history = await ApiService.getDoseHistory(userId: _selectedUser, limit: 20);
      if (mounted) {
        setState(() { _schedule = schedule; _history = history; });
      }
    } catch (_) {} finally {
      if (mounted) setState(() => _loadingData = false);
    }
  }

  Future<void> _markAsTaken(dynamic item, {bool isHistory = false}) async {
    try {
      final logId = item['log_id'] ?? item['id'] ?? item['_id'];
      if (logId != null) {
        await ApiService.updateLog(logId.toString(), 'taken', notes: 'Marked as taken by caregiver');
      } else {
        // No log exists — create one
        await ApiService.recordDose(
          item['medication_id'].toString(),
          'taken',
          item['scheduled_time'] ?? '00:00',
          notes: 'Marked as taken by caregiver',
        );
      }
      _loadMedData();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to update: $e'), backgroundColor: AppColors.danger),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async {
        await _loadMedData();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: const [
                    Text('Medications', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                    SizedBox(height: 2),
                    Text('Schedules & History', style: TextStyle(color: Colors.black54, fontSize: 13)),
                  ]),
                ),
                const SizedBox(width: 8),
                AnimatedBuilder(
                  animation: SelectedUserService(),
                  builder: (context, child) {
                    final service = SelectedUserService();
                    if (service.monitoringUsers.isEmpty) return const SizedBox.shrink();
                    return Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 0),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: Colors.grey.shade300),
                      ),
                      child: DropdownButtonHideUnderline(
                        child: DropdownButton<String>(
                          isDense: true,
                          value: service.selectedUser?['_id'],
                          icon: const Icon(Icons.arrow_drop_down, color: Colors.black54, size: 18),
                          style: const TextStyle(color: Colors.black87, fontWeight: FontWeight.bold, fontSize: 12),
                          onChanged: (String? newValue) {
                            if (newValue != null) service.setSelectedUser(newValue);
                          },
                          items: service.monitoringUsers.map<DropdownMenuItem<String>>((dynamic u) {
                            return DropdownMenuItem<String>(
                              value: u['_id'],
                              child: Text(u['name'] ?? 'Unknown', style: const TextStyle(fontSize: 12)),
                            );
                          }).toList(),
                        ),
                      ),
                    );
                  },
                ),
              ],
            ),
            const SizedBox(height: 24),

            if (SelectedUserService().isLoading)
              const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
            else if (SelectedUserService().monitoringUsers.isEmpty)
              _emptyState('No family members', 'Link family members to view their medications.', Icons.medication_outlined)
            else if (_selectedUser == null)
              _emptyState('Select a family member', 'Choose from the dropdown in the header.', Icons.medication_outlined)
            else ...[
              // Today's Schedule
              _sectionHeader("Today's Schedule", '${_schedule.length} doses'),
              const SizedBox(height: 10),
              if (_loadingData)
                const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
              else if (_schedule.isEmpty)
                _emptyState('No medications scheduled', 'No doses scheduled for today.', Icons.medication_outlined)
              else
                Container(
                  decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                  clipBehavior: Clip.antiAlias,
                  child: Column(
                    children: _schedule.asMap().entries.map((e) => _buildScheduleItem(e.value, e.key)).toList(),
                  ),
                ),

              const SizedBox(height: 24),

              // History
              _sectionHeader('Recent History', '${_history.length} events'),
              const SizedBox(height: 10),
              if (_history.isEmpty)
                _emptyState('No history', 'No dose events recorded yet.', Icons.history)
              else
                Container(
                  decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                  clipBehavior: Clip.antiAlias,
                  child: Column(
                    children: _history.asMap().entries.map((e) => _buildHistoryItem(e.value, e.key)).toList(),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _sectionHeader(String title, String subtitle) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        Text(subtitle, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
      ],
    );
  }

  Widget _buildScheduleItem(dynamic s, int index) {
    final status = s['status'] ?? 'scheduled';
    final showAction = ['camera_off', 'missed', 'scheduled', 'needs_verification'].contains(status);
    return Container(
      decoration: BoxDecoration(
        border: index < _schedule.length - 1 ? const Border(bottom: BorderSide(color: AppColors.borderLight)) : null,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          // Time
          SizedBox(
            width: 60,
            child: Text(s['scheduled_time'] ?? '', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
          ),
          const SizedBox(width: 12),
          // Med info
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s['medication_name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
              Text(s['dosage'] ?? '', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
            ]),
          ),
          // Status badge
          _statusBadge(status),
          // Mark Taken button
          if (showAction) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap: () => _markAsTaken(s),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: AppColors.success.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.success.withValues(alpha: 0.4)),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.check_circle_outline, size: 14, color: AppColors.success),
                    SizedBox(width: 4),
                    Text('Taken', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: AppColors.success)),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildHistoryItem(dynamic h, int index) {
    final status = h['status'] ?? 'scheduled';
    final confidence = h['confidence_score'];
    final showAction = ['camera_off', 'missed'].contains(status);
    return Container(
      decoration: BoxDecoration(
        border: index < _history.length - 1 ? const Border(bottom: BorderSide(color: AppColors.borderLight)) : null,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(
                h['medication_name'] ?? (h['medication_id'] is Map ? h['medication_id']['name'] : null) ?? '—',
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
              ),
              Text(_formatTime(h['scheduled_time'] ?? h['createdAt']), style: const TextStyle(fontSize: 10, color: AppColors.textMuted)),
            ]),
          ),
          if (confidence != null)
            Padding(
              padding: const EdgeInsets.only(right: 10),
              child: Text('${((confidence as num) * 100).toStringAsFixed(0)}%', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
            ),
          _statusBadge(status),
          if (showAction) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap: () => _markAsTaken(h, isHistory: true),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: AppColors.success.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.success.withValues(alpha: 0.4)),
                ),
                child: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.check_circle_outline, size: 14, color: AppColors.success),
                    SizedBox(width: 4),
                    Text('Taken', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: AppColors.success)),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _statusBadge(String status) {
    final colors = {
      'taken': AppColors.success,
      'missed': AppColors.danger,
      'camera_off': const Color(0xFF6B7280),
      'snoozed': AppColors.warning,
    };
    final c = colors[status] ?? AppColors.textMuted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(20)),
      child: Text(status.replaceAll('_', ' ').toUpperCase(), style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: c)),
    );
  }

  Widget _emptyState(String title, String desc, IconData icon) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
      child: Column(children: [
        Icon(icon, size: 40, color: AppColors.textMuted),
        const SizedBox(height: 10),
        Text(title, style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
        const SizedBox(height: 4),
        Text(desc, style: TextStyle(fontSize: 12, color: AppColors.textMuted), textAlign: TextAlign.center),
      ]),
    );
  }

  String _formatTime(String? raw) {
    if (raw == null) return '—';
    try { return DateTime.parse(raw).toLocal().toString().substring(0, 16); } catch (_) { return raw; }
  }
}
