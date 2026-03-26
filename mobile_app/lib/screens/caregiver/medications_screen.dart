import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class CaregiverMedicationsScreen extends StatefulWidget {
  const CaregiverMedicationsScreen({super.key});

  @override
  State<CaregiverMedicationsScreen> createState() => _CaregiverMedicationsScreenState();
}

class _CaregiverMedicationsScreenState extends State<CaregiverMedicationsScreen> {
  List<dynamic> _users = [];
  String? _selectedUser;
  List<dynamic> _schedule = [];
  List<dynamic> _history = [];
  bool _loadingUsers = true;
  bool _loadingData = false;

  @override
  void initState() {
    super.initState();
    _loadUsers();
  }

  Future<void> _loadUsers() async {
    setState(() => _loadingUsers = true);
    try {
      final users = await ApiService.getMonitoredUsers();
      setState(() {
        _users = users;
        if (users.isNotEmpty) _selectedUser = users[0]['_id'];
      });
      if (_selectedUser != null) _loadMedData();
    } catch (_) {} finally {
      setState(() => _loadingUsers = false);
    }
  }

  Future<void> _loadMedData() async {
    if (_selectedUser == null) return;
    setState(() => _loadingData = true);
    try {
      final schedule = await ApiService.getSchedule(userId: _selectedUser);
      final history = await ApiService.getDoseHistory(userId: _selectedUser, limit: 20);
      setState(() { _schedule = schedule; _history = history; });
    } catch (_) {} finally {
      setState(() => _loadingData = false);
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
              children: [
                const Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Medications', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  SizedBox(height: 2),
                  Text('Track schedules & adherence', style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
                ]),
                if (_users.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        value: _selectedUser,
                        items: _users.map<DropdownMenuItem<String>>((u) {
                          return DropdownMenuItem(
                            value: u['_id'] as String,
                            child: Text(u['name'] ?? '', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                          );
                        }).toList(),
                        onChanged: (v) {
                          setState(() => _selectedUser = v);
                          _loadMedData();
                        },
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 20),

            if (_loadingUsers)
              const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
            else if (_users.isEmpty)
              _emptyState('No family members', 'Link family members to view their medications.', Icons.medication_outlined)
            else if (_selectedUser == null)
              _emptyState('Select a family member', 'Choose from the dropdown above.', Icons.medication_outlined)
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
                    children: _schedule.asMap().entries.map((e) {
                      final s = e.value;
                      return Container(
                        decoration: BoxDecoration(
                          border: e.key < _schedule.length - 1 ? const Border(bottom: BorderSide(color: AppColors.borderLight)) : null,
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
                            // Status
                            _statusBadge(s['status'] ?? 'scheduled'),
                          ],
                        ),
                      );
                    }).toList(),
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
                    children: _history.asMap().entries.map((e) {
                      final h = e.value;
                      final confidence = h['confidence_score'];
                      return Container(
                        decoration: BoxDecoration(
                          border: e.key < _history.length - 1 ? const Border(bottom: BorderSide(color: AppColors.borderLight)) : null,
                        ),
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(h['medication_id']?['name'] ?? h['medication_name'] ?? '—', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                                Text(_formatTime(h['scheduled_time'] ?? h['createdAt']), style: const TextStyle(fontSize: 10, color: AppColors.textMuted)),
                              ]),
                            ),
                            if (confidence != null)
                              Padding(
                                padding: const EdgeInsets.only(right: 10),
                                child: Text('${((confidence as num) * 100).toStringAsFixed(0)}%', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                              ),
                            _statusBadge(h['status'] ?? 'scheduled'),
                          ],
                        ),
                      );
                    }).toList(),
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

  Widget _statusBadge(String status) {
    final colors = {
      'taken': AppColors.success,
      'missed': AppColors.danger,
      'snoozed': AppColors.warning,
    };
    final c = colors[status] ?? AppColors.textMuted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(20)),
      child: Text(status.toUpperCase(), style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: c)),
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
