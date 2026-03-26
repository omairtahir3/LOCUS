import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import 'family_detail_screen.dart';

class FamilyMembersScreen extends StatefulWidget {
  const FamilyMembersScreen({super.key});

  @override
  State<FamilyMembersScreen> createState() => _FamilyMembersScreenState();
}

class _FamilyMembersScreenState extends State<FamilyMembersScreen> {
  List<dynamic> _users = [];
  Map<String, dynamic> _summaries = {};
  bool _loading = true;
  String _search = '';

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
      setState(() { _users = users; _summaries = summaries; });
    } catch (_) {} finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _users.where((u) {
      final name = (u['name'] ?? '').toString().toLowerCase();
      final email = (u['email'] ?? '').toString().toLowerCase();
      return name.contains(_search.toLowerCase()) || email.contains(_search.toLowerCase());
    }).toList();

    return RefreshIndicator(
      onRefresh: _loadData,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Family Members', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text('People you\'re monitoring', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
            const SizedBox(height: 16),

            // Search
            TextField(
              onChanged: (v) => setState(() => _search = v),
              decoration: InputDecoration(
                hintText: 'Search family members...',
                prefixIcon: const Icon(Icons.search, size: 18),
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              ),
            ),
            const SizedBox(height: 16),

            if (_loading)
              const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
            else if (filtered.isEmpty)
              Container(
                padding: const EdgeInsets.all(40),
                decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                child: Column(
                  children: [
                    Icon(Icons.people_outline, size: 48, color: AppColors.textMuted),
                    const SizedBox(height: 12),
                    Text(_search.isNotEmpty ? 'No matching members' : 'No family members linked', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                    const SizedBox(height: 4),
                    Text('Ask your elderly family members to add your email in their LOCUS app settings.', style: TextStyle(fontSize: 12, color: AppColors.textMuted), textAlign: TextAlign.center),
                  ],
                ),
              )
            else
              ...filtered.asMap().entries.map((e) {
                final i = e.key;
                final u = e.value;
                final s = _summaries[u['_id']];
                final adh = s?['today_adherence'];
                final colors = [AppColors.primary, const Color(0xFF6366F1), const Color(0xFFEC4899), const Color(0xFFF59E0B), const Color(0xFF10B981)];
                return GestureDetector(
                  onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => FamilyDetailScreen(user: u, summary: s))),
                  child: Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                    child: Column(
                      children: [
                        Row(
                          children: [
                            CircleAvatar(
                              radius: 24,
                              backgroundColor: colors[i % colors.length],
                              child: Text(u['name']?.toString().substring(0, 1).toUpperCase() ?? '?', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 18)),
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(u['name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                                  Text(u['email'] ?? '', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                                ],
                              ),
                            ),
                            Icon(Icons.chevron_right, color: AppColors.textMuted, size: 20),
                          ],
                        ),
                        if (adh != null) ...[
                          const SizedBox(height: 14),
                          Container(height: 1, color: AppColors.border),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              _miniStat('Taken', '${adh['taken'] ?? 0}', AppColors.success),
                              _miniStat('Missed', '${adh['missed'] ?? 0}', AppColors.danger),
                              _miniStat('Adherence', '${(adh['adherence_percentage'] ?? 0).toStringAsFixed(0)}%', AppColors.primary),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  Widget _miniStat(String label, String value, Color color) {
    return Expanded(
      child: Column(
        children: [
          Text(value, style: TextStyle(fontWeight: FontWeight.w700, color: color, fontSize: 16)),
          Text(label, style: TextStyle(fontSize: 10, color: AppColors.textMuted)),
        ],
      ),
    );
  }
}
