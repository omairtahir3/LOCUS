import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class MemoryScreen extends StatefulWidget {
  const MemoryScreen({super.key});

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> {
  final _searchCtrl = TextEditingController();
  String _activeFilter = 'All';
  final _filters = ['All', 'People', 'Places', 'Objects', 'Events'];

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Search bar
        Container(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
          color: AppColors.surface,
          child: Column(
            children: [
              Row(
                children: [
                  const Expanded(
                    child: Text('Memory Search', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(colors: [AppColors.accent, AppColors.primary]),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.rocket_launch, size: 10, color: Colors.white),
                        SizedBox(width: 4),
                        Text('Coming Soon', style: TextStyle(color: Colors.white, fontSize: 9, fontWeight: FontWeight.w700)),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _searchCtrl,
                      decoration: InputDecoration(
                        hintText: 'Search your memories...',
                        prefixIcon: const Icon(Icons.search, size: 20),
                        contentPadding: const EdgeInsets.symmetric(vertical: 10),
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    decoration: BoxDecoration(
                      color: AppColors.primary,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: IconButton(
                      onPressed: () {},
                      icon: const Icon(Icons.mic, color: Colors.white, size: 20),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              // Filter chips
              SizedBox(
                height: 34,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: _filters.map((f) =>
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(f, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600,
                          color: _activeFilter == f ? Colors.white : AppColors.textSecondary)),
                        selected: _activeFilter == f,
                        onSelected: (_) => setState(() => _activeFilter = f),
                        selectedColor: AppColors.primary,
                        backgroundColor: AppColors.borderLight,
                        side: BorderSide.none,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
                  ).toList(),
                ),
              ),
            ],
          ),
        ),

        // Results
        Expanded(
          child: _searchCtrl.text.isNotEmpty
              ? _buildSearchResults()
              : _buildRecentMemories(),
        ),
      ],
    );
  }

  Widget _buildSearchResults() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.search_off, size: 56, color: AppColors.textMuted),
          const SizedBox(height: 12),
          Text('Search coming soon', style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text('Multi-modal memory search will be\navailable with the AI backend',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
        ],
      ),
    );
  }

  Widget _buildRecentMemories() {
    final memories = [
      _MemoryItem('Morning walk in the park', '2 hours ago', Icons.directions_walk, AppColors.info, 'Today'),
      _MemoryItem('Met Sarah at the cafe', '4 hours ago', Icons.person, AppColors.accent, 'Today'),
      _MemoryItem('Took morning medication', '6 hours ago', Icons.medication, AppColors.success, 'Today'),
      _MemoryItem('Doctor appointment', 'Yesterday', Icons.local_hospital, AppColors.danger, 'Yesterday'),
      _MemoryItem('Grocery shopping', 'Yesterday', Icons.shopping_cart, AppColors.warning, 'Yesterday'),
      _MemoryItem('Video call with family', '2 days ago', Icons.video_call, AppColors.primary, '2 Days Ago'),
    ];

    String? lastGroup;
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: memories.length,
      itemBuilder: (ctx, i) {
        final m = memories[i];
        final showHeader = m.group != lastGroup;
        lastGroup = m.group;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (showHeader) Padding(
              padding: EdgeInsets.only(top: i == 0 ? 0 : 16, bottom: 8),
              child: Text(m.group, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700,
                  color: AppColors.textMuted, letterSpacing: 0.5)),
            ),
            Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                leading: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: m.color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
                  child: Icon(m.icon, color: m.color, size: 20),
                ),
                title: Text(m.title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                subtitle: Text(m.time, style: TextStyle(color: AppColors.textSecondary, fontSize: 11)),
                trailing: const Icon(Icons.chevron_right, color: AppColors.textMuted, size: 18),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _MemoryItem {
  final String title, time, group;
  final IconData icon;
  final Color color;
  _MemoryItem(this.title, this.time, this.icon, this.color, this.group);
}
