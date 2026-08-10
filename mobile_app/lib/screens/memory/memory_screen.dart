import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class MemoryScreen extends StatefulWidget {
  const MemoryScreen({super.key});

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> {
  final _searchCtrl = TextEditingController();
  String _activeFilter = 'All';
  final _filters = ['All', 'Medicine', 'People'];
  
  List<dynamic> _events = [];
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _loadEvents();
  }

  Future<void> _loadEvents() async {
    setState(() => _isLoading = true);
    try {
      final res = await ApiService.getMemorySearchEvents(limit: 50);
      setState(() => _events = res);
    } catch (e) {
      debugPrint('Error loading memories: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _toggleFlag(String eventId, bool currentFlag) async {
    final success = await ApiService.toggleEventFlag(eventId, !currentFlag);
    if (success) {
      _loadEvents();
    } else {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to toggle flag')),
        );
      }
    }
  }

  List<_MemoryItem> _getFormattedMemories() {
    return _events.map((ev) {
      final dt = DateTime.parse(ev['timestamp']);
      final now = DateTime.now();
      final diff = now.difference(dt);
      
      String timeLabel = '-';
      String groupLabel = 'Earlier';
      
      if (diff.inDays == 0) {
        timeLabel = diff.inHours < 1 ? 'Just now' : '${diff.inHours} hours ago';
        groupLabel = 'Today';
      } else if (diff.inDays == 1) {
        timeLabel = 'Yesterday';
        groupLabel = 'Yesterday';
      } else {
        timeLabel = '${diff.inDays} days ago';
        groupLabel = '${diff.inDays} Days Ago';
      }

      if (ev['event_type'] == 'medication_intake' || ev['event_type'] == 'medication') {
        return _MemoryItem(
          id: ev['_id'],
          title: 'Took ${ev['details']?['medication_name'] ?? 'medication'}',
          time: timeLabel,
          icon: Icons.medication,
          color: AppColors.success,
          group: groupLabel,
          category: 'Medicine',
          imageUrl: ev['keyframe_id'] != null ? ApiService.medicationFrameImageUrl(ev['keyframe_id']) : null,
          isFlagged: ev['is_flagged'] == true,
        );
      } else if (ev['event_type'] == 'social_interaction') {
        final personName = ev['person_id']?['person_name'] ?? ev['details']?['person'] ?? 'Unknown Person';
        return _MemoryItem(
          id: ev['_id'],
          title: 'Saw $personName',
          time: timeLabel,
          icon: Icons.person,
          color: AppColors.primary,
          group: groupLabel,
          category: 'People',
          imageUrl: ev['keyframe_id'] != null ? '${ApiService.baseUrl}/detection/keyframes/${ev['keyframe_id']}/image' : null,
          isFlagged: ev['is_flagged'] == true,
        );
      }
      return null;
    }).where((item) => item != null).cast<_MemoryItem>().toList();
  }

  @override
  Widget build(BuildContext context) {
    final allMemories = _getFormattedMemories();
    
    // Apply filter
    final filtered = _activeFilter == 'All' 
        ? allMemories 
        : allMemories.where((m) => m.category == _activeFilter).toList();
        
    // Apply search
    final query = _searchCtrl.text.toLowerCase();
    final searched = query.isNotEmpty 
        ? filtered.where((m) => m.title.toLowerCase().contains(query)).toList()
        : filtered;

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
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _searchCtrl,
                      onChanged: (_) => setState(() {}),
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
                  children: _filters.map((f) {
                    final count = f == 'All' ? allMemories.length : allMemories.where((m) => m.category == f).length;
                    return Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text('$f ($count)', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600,
                          color: _activeFilter == f ? Colors.white : AppColors.textSecondary)),
                        selected: _activeFilter == f,
                        onSelected: (_) => setState(() => _activeFilter = f),
                        selectedColor: AppColors.primary,
                        backgroundColor: AppColors.borderLight,
                        side: BorderSide.none,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        visualDensity: VisualDensity.compact,
                      ),
                    );
                  }).toList(),
                ),
              ),
            ],
          ),
        ),

        // Results
        Expanded(
          child: _isLoading 
            ? const Center(child: CircularProgressIndicator())
            : searched.isEmpty 
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.search_off, size: 56, color: AppColors.textMuted),
                      const SizedBox(height: 12),
                      Text(query.isNotEmpty ? 'No results found' : 'No memories yet', 
                           style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Text('When the AI camera detects events, they will appear here.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                    ],
                  ),
                )
              : _buildMemoriesList(searched),
        ),
      ],
    );
  }

  Widget _buildMemoriesList(List<_MemoryItem> memories) {
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
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(
                  color: m.isFlagged ? AppColors.primary : Colors.transparent,
                  width: m.isFlagged ? 2 : 0,
                ),
              ),
              child: ListTile(
                leading: Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(color: m.color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
                  child: m.imageUrl != null 
                    ? ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: Image.network(m.imageUrl!, fit: BoxFit.cover, errorBuilder: (c,e,s) => Icon(m.icon, color: m.color, size: 20)),
                      )
                    : Icon(m.icon, color: m.color, size: 20),
                ),
                title: Text(m.title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                subtitle: Text(m.time, style: TextStyle(color: AppColors.textSecondary, fontSize: 11)),
                trailing: IconButton(
                  icon: Icon(Icons.push_pin, size: 20, color: m.isFlagged ? AppColors.primary : AppColors.border),
                  onPressed: () => _toggleFlag(m.id, m.isFlagged),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _MemoryItem {
  final String id, title, time, group, category;
  final IconData icon;
  final Color color;
  final String? imageUrl;
  final bool isFlagged;
  
  _MemoryItem({
    required this.id, required this.title, required this.time, 
    required this.icon, required this.color, required this.group,
    required this.category, this.imageUrl, this.isFlagged = false,
  });
}
