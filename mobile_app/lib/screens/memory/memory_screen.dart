import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher_string.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/selected_user_service.dart';

class MemoryScreen extends StatefulWidget {
  final String? targetUserId;
  const MemoryScreen({super.key, this.targetUserId});

  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> {
  final _searchCtrl = TextEditingController();
  String _activeFilter = 'All';
  final _filters = ['All', 'Medicine', 'People', 'Activity', 'Objects'];
  
  static const Map<String, IconData> _filterIcons = {
    'All': Icons.grid_view_rounded,
    'Medicine': Icons.medication_outlined,
    'People': Icons.people_outline,
    'Activity': Icons.directions_run_outlined,
    'Objects': Icons.inventory_2_outlined,
  };
  
  List<dynamic> _events = [];
  bool _isLoading = false;
  /// One day at a time, like the Activity Feed. null means "all days", the
  /// old behaviour of showing the most recent memories regardless of date.
  DateTime? _date = DateTime.now();

  bool get _isToday => _date != null && DateUtils.isSameDay(_date!, DateTime.now());

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? DateTime.now(),
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
    );
    if (picked != null) {
      setState(() => _date = picked);
      _loadEvents();
    }
  }

  void _shiftDay(int days) {
    final base = _date ?? DateTime.now();
    final next = base.add(Duration(days: days));
    if (next.isAfter(DateTime.now())) return;
    setState(() => _date = next);
    _loadEvents();
  }

  @override
  void initState() {
    super.initState();
    SelectedUserService().addListener(_onSelectedUserChanged);
    _loadEvents();
  }

  void _onSelectedUserChanged() {
    if (mounted) _loadEvents();
  }

  @override
  void dispose() {
    SelectedUserService().removeListener(_onSelectedUserChanged);
    _searchCtrl.dispose();
    super.dispose();
  }

  void reload() {
    if (mounted) _loadEvents();
  }

  Future<void> _loadEvents() async {
    setState(() => _isLoading = true);
    try {
      String? selectedId = widget.targetUserId;
      if (selectedId == null && ApiService.userRole == 'caregiver') {
        selectedId = SelectedUserService().selectedUser?['_id']?.toString();
      }
      // A chosen day returns EVERY memory from it. The old limit of 50 hid
      // whole afternoons, which is the opposite of what a memory aid is for.
      final res = await ApiService.getMemorySearchEvents(
        userId: selectedId,
        date: _date == null ? null : DateFormat('yyyy-MM-dd').format(_date!),
      );
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

  void _showImagePreview(String imageUrl, String title) {
    showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.black87,
        insetPadding: const EdgeInsets.all(16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close, color: Colors.white, size: 22),
                    onPressed: () => Navigator.pop(ctx),
                  ),
                ],
              ),
            ),
            ClipRRect(
              borderRadius: const BorderRadius.vertical(bottom: Radius.circular(16)),
              child: Image.network(
                imageUrl,
                fit: BoxFit.contain,
                errorBuilder: (_, __, ___) => Container(
                  padding: const EdgeInsets.all(32),
                  color: Colors.grey.shade900,
                  child: const Center(
                    child: Text('Failed to load image', style: TextStyle(color: Colors.white70)),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<_MemoryItem> _getFormattedMemories() {
    return _events.map((ev) {
      try {
        final dt = DateTime.parse(ev['timestamp']);
        final localDt = dt.toLocal();
        final timeLabel = DateFormat('h:mm a').format(localDt);
        final now = DateTime.now();
        
        String groupLabel = 'Earlier';
        
        if (_date != null) {
          // Viewing one day: a single "Today" heading is just a wall of cards,
          // so split it into the parts of the day instead.
          final h = localDt.hour;
          groupLabel = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
        } else if (now.year == localDt.year && now.month == localDt.month && now.day == localDt.day) {
          groupLabel = 'Today';
        } else if (now.year == localDt.year && now.month == localDt.month && now.day - 1 == localDt.day) {
          groupLabel = 'Yesterday';
        } else {
          groupLabel = DateFormat('MMM d, yyyy').format(localDt);
        }

        if (ev['event_type'] == 'medication_intake' || ev['event_type'] == 'medication') {
          final details = ev['details'];
          return _MemoryItem(
            id: ev['_id'],
            title: 'Took ${(details is Map ? details['medication_name'] : null) ?? 'medication'}',
            time: timeLabel,
            icon: Icons.medication,
            color: AppColors.success,
            group: groupLabel,
            category: 'Medicine',
            imageUrl: ev['keyframe_id'] != null ? ApiService.medicationFrameImageUrl(ev['keyframe_id']) : null,
            isFlagged: ev['is_flagged'] == true,
            location: ev['location'],
          );
        } else if (ev['event_type'] == 'social_interaction') {
          final pIdData = ev['person_id'];
          final details = ev['details'];
          
          final personName = (pIdData is Map ? pIdData['person_name'] : null) 
              ?? (details is Map ? details['person'] : null) 
              ?? 'Unknown Person';
              
          final personId = pIdData is Map ? pIdData['_id'] : (pIdData is String ? pIdData : null);
          
          return _MemoryItem(
            id: ev['_id'],
            title: 'Saw $personName',
            time: timeLabel,
            icon: Icons.person,
            color: AppColors.primary,
            group: groupLabel,
            category: 'People',
            imageUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id']) : null,
            isFlagged: ev['is_flagged'] == true,
            personId: personId,
            location: ev['location'],
          );
        } else if (ev['event_type'] == 'activity') {
          final details = ev['details'];
          return _MemoryItem(
            id: ev['_id'],
            title: (details is Map ? details['sentence'] : null) ?? 'Activity detected',
            time: timeLabel,
            icon: Icons.directions_run,
            color: AppColors.warning,
            group: groupLabel,
            category: 'Activity',
            imageUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id']) : null,
            isFlagged: ev['is_flagged'] == true,
            location: ev['location'],
          );
        } else if (ev['event_type'] == 'object') {
          final details = ev['details'];
          List<String> itemNames = [];
          if (details is Map) {
            if (details['item_names'] is List) {
              itemNames = (details['item_names'] as List).map((e) => e.toString()).toList();
            } else if (details['items'] is List) {
              itemNames = (details['items'] as List)
                  .map((e) => (e is Map ? e['name']?.toString() : null) ?? '')
                  .where((s) => s.isNotEmpty)
                  .toList();
            }
          }
          
          final summary = (details is Map ? details['summary'] : null)?.toString();
          final titleText = itemNames.isNotEmpty
              ? 'Spotted ${itemNames.take(3).join(', ')}${itemNames.length > 3 ? ' +${itemNames.length - 3} more' : ''}'
              : (summary ?? 'Items detected');

          return _MemoryItem(
            id: ev['_id'],
            title: titleText,
            time: timeLabel,
            icon: Icons.inventory_2_outlined,
            color: const Color(0xFF6366F1),
            group: groupLabel,
            category: 'Objects',
            imageUrl: ev['keyframe_id'] != null ? ApiService.keyframeImageUrl(ev['keyframe_id']) : null,
            isFlagged: ev['is_flagged'] == true,
            location: ev['location'],
            itemNames: itemNames,
          );
        }
        return null;
      } catch (e, st) {
        debugPrint('Error parsing memory event: $e\n$st');
        return _MemoryItem(
          id: ev['_id']?.toString() ?? 'error',
          title: 'Parse Error: $e',
          time: '-',
          icon: Icons.error,
          color: Colors.red,
          group: 'Errors',
          category: 'All',
        );
      }
    }).where((item) => item != null).cast<_MemoryItem>().toList();
  }

  @override
  Widget build(BuildContext context) {
    final allMemories = _getFormattedMemories();
    final objectMemories = allMemories.where((m) => m.category == 'Objects').toList();
    
    // Apply filter
    final filtered = _activeFilter == 'All' 
        ? allMemories 
        : allMemories.where((m) => m.category == _activeFilter).toList();
        
    // Apply search
    final query = _searchCtrl.text.toLowerCase().trim();
    final searched = query.isNotEmpty 
        ? filtered.where((m) {
            if (m.title.toLowerCase().contains(query)) return true;
            if (m.itemNames != null && m.itemNames!.any((name) => name.toLowerCase().contains(query))) return true;
            return false;
          }).toList()
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
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Memory Search', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  if (ApiService.userRole == 'caregiver')
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
              const SizedBox(height: 12),
              // Day selector, matching the Activity Feed.
              Row(
                children: [
                  IconButton(
                    onPressed: () => _shiftDay(-1),
                    icon: const Icon(Icons.chevron_left),
                    tooltip: 'Previous day',
                    visualDensity: VisualDensity.compact,
                  ),
                  Expanded(
                    child: InkWell(
                      onTap: _pickDate,
                      borderRadius: BorderRadius.circular(10),
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 10),
                        decoration: BoxDecoration(
                          color: AppColors.surface,
                          border: Border.all(color: AppColors.border),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.calendar_today_outlined, size: 15, color: AppColors.textMuted),
                            const SizedBox(width: 7),
                            Flexible(
                              child: Text(
                                _date == null
                                    ? 'All days'
                                    : _isToday ? 'Today' : DateFormat('EEE d MMM').format(_date!),
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: (_date == null || _isToday) ? null : () => _shiftDay(1),
                    icon: const Icon(Icons.chevron_right),
                    tooltip: 'Next day',
                    visualDensity: VisualDensity.compact,
                  ),
                  TextButton(
                    onPressed: () {
                      setState(() => _date = _date == null ? DateTime.now() : null);
                      _loadEvents();
                    },
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(0, 36),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Text(_date == null ? 'By day' : 'All days',
                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _searchCtrl,
                      onChanged: (_) => setState(() {}),
                      decoration: InputDecoration(
                        hintText: 'Search memories, people, objects...',
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
                height: 36,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: _filters.map((f) {
                    final count = f == 'All' ? allMemories.length : allMemories.where((m) => m.category == f).length;
                    final isSelected = _activeFilter == f;
                    final icon = _filterIcons[f];
                    return Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        showCheckmark: false,
                        avatar: icon != null 
                            ? Icon(icon, size: 14, color: isSelected ? Colors.white : AppColors.textSecondary)
                            : null,
                        label: Text('$f ($count)', style: TextStyle(
                          fontSize: 11, 
                          fontWeight: FontWeight.w600,
                          color: isSelected ? Colors.white : AppColors.textSecondary,
                        )),
                        selected: isSelected,
                        onSelected: (_) => setState(() => _activeFilter = f),
                        selectedColor: f == 'Objects' ? const Color(0xFF4F46E5) : AppColors.primary,
                        backgroundColor: AppColors.borderLight,
                        side: BorderSide.none,
                        padding: const EdgeInsets.symmetric(horizontal: 4),
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
            : RefreshIndicator(
                onRefresh: _loadEvents,
                child: searched.isEmpty 
                  ? SingleChildScrollView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      child: Container(
                        height: MediaQuery.of(context).size.height * 0.5,
                        alignment: Alignment.center,
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.search_off, size: 56, color: AppColors.textMuted),
                            const SizedBox(height: 12),
                            Text(query.isNotEmpty ? 'No results found' : 'No memories yet', 
                                 style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 4),
                            Text('When the AI camera detects items or events, they will appear here.',
                                textAlign: TextAlign.center,
                                style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                          ],
                        ),
                      ),
                    )
                  : _buildMemoriesList(searched, objectMemories, query),
              ),
        ),
      ],
    );
  }

  Widget _buildObjectsCarousel(List<_MemoryItem> objectMemories) {
    if (objectMemories.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF6366F1).withAlpha(15),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF6366F1).withAlpha(40)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: const [
                  Icon(Icons.inventory_2_outlined, color: Color(0xFF4F46E5), size: 18),
                  SizedBox(width: 6),
                  Text('Detected Objects & Items', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: Color(0xFF312E81))),
                ],
              ),
              GestureDetector(
                onTap: () => setState(() => _activeFilter = 'Objects'),
                child: const Text('View All', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Color(0xFF4F46E5))),
              ),
            ],
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 110,
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              itemCount: objectMemories.length,
              itemBuilder: (ctx, i) {
                final obj = objectMemories[i];
                final displayName = (obj.itemNames != null && obj.itemNames!.isNotEmpty)
                    ? obj.itemNames!.first
                    : obj.title;
                return GestureDetector(
                  onTap: () {
                    if (obj.imageUrl != null) {
                      _showImagePreview(obj.imageUrl!, obj.title);
                    }
                  },
                  child: Container(
                    width: 120,
                    margin: const EdgeInsets.only(right: 10),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: Colors.black.withAlpha(15)),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withAlpha(8),
                          blurRadius: 4,
                          offset: const Offset(0, 2),
                        ),
                      ],
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: ClipRRect(
                            borderRadius: const BorderRadius.vertical(top: Radius.circular(11)),
                            child: obj.imageUrl != null
                                ? Image.network(
                                    obj.imageUrl!,
                                    width: double.infinity,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, __, ___) => Container(
                                      color: const Color(0xFF6366F1).withAlpha(20),
                                      child: const Center(child: Icon(Icons.inventory_2, color: Color(0xFF6366F1), size: 24)),
                                    ),
                                  )
                                : Container(
                                    color: const Color(0xFF6366F1).withAlpha(20),
                                    child: const Center(child: Icon(Icons.inventory_2, color: Color(0xFF6366F1), size: 24)),
                                  ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                displayName,
                                style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 11),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              Text(
                                obj.time,
                                style: TextStyle(color: AppColors.textSecondary, fontSize: 9),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMemoriesList(List<_MemoryItem> memories, List<_MemoryItem> objectMemories, String query) {
    String? lastGroup;
    final showObjectsCarousel = _activeFilter == 'All' && query.isEmpty && objectMemories.isNotEmpty;
    
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(16),
      itemCount: memories.length + (showObjectsCarousel ? 1 : 0),
      itemBuilder: (ctx, idx) {
        if (showObjectsCarousel && idx == 0) {
          return _buildObjectsCarousel(objectMemories);
        }

        final i = showObjectsCarousel ? idx - 1 : idx;
        final m = memories[i];
        final showHeader = m.group != lastGroup;
        lastGroup = m.group;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (showHeader) Padding(
              padding: EdgeInsets.only(top: i == 0 && !showObjectsCarousel ? 0 : 16, bottom: 8),
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
                onTap: () {
                  if (m.personId != null) {
                    Navigator.pushNamed(context, '/past-interactions', arguments: m.personId);
                  } else if (m.imageUrl != null) {
                    _showImagePreview(m.imageUrl!, m.title);
                  }
                },
                leading: GestureDetector(
                  onTap: m.imageUrl != null ? () => _showImagePreview(m.imageUrl!, m.title) : null,
                  child: Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(color: m.color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
                    child: m.imageUrl != null 
                      ? ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.network(
                            m.imageUrl!,
                            fit: BoxFit.cover,
                            errorBuilder: (c, e, s) => Icon(m.icon, color: m.color, size: 20),
                          ),
                        )
                      : Icon(m.icon, color: m.color, size: 20),
                  ),
                ),
                title: Text(
                  m.title, 
                  style: TextStyle(
                    fontWeight: FontWeight.w600, 
                    fontSize: 14,
                    color: m.personId != null ? AppColors.primary : AppColors.textPrimary,
                    decoration: m.personId != null ? TextDecoration.underline : TextDecoration.none,
                  ),
                ),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (m.itemNames != null && m.itemNames!.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Wrap(
                        spacing: 4,
                        runSpacing: 4,
                        children: m.itemNames!.take(4).map((name) => Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                          decoration: BoxDecoration(
                            color: const Color(0xFF6366F1).withAlpha(20),
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: const Color(0xFF6366F1).withAlpha(50), width: 0.5),
                          ),
                          child: Text(
                            name,
                            style: const TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                              color: Color(0xFF4F46E5),
                            ),
                          ),
                        )).toList(),
                      ),
                    ],
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        Text(m.time, style: TextStyle(color: AppColors.textSecondary, fontSize: 11)),
                        if (m.location != null) ...[
                          const SizedBox(width: 6),
                          Tooltip(
                            message: 'Lat: ${m.location!['lat']}, Lng: ${m.location!['lng']}',
                            triggerMode: TooltipTriggerMode.tap,
                            child: GestureDetector(
                              onTap: () {
                                launchUrlString('https://www.google.com/maps/search/?api=1&query=${m.location!['lat']},${m.location!['lng']}');
                              },
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFEEECF9),
                                  borderRadius: BorderRadius.circular(12),
                                ),
                                child: Row(
                                  children: const [
                                    Icon(Icons.location_on, size: 10, color: Color(0xFF4F46E5)),
                                    SizedBox(width: 2),
                                    Text('Location Logged', style: TextStyle(
                                      fontSize: 9, 
                                      fontWeight: FontWeight.w700, 
                                      color: Color(0xFF4F46E5)
                                    )),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
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
  final String? personId;
  final Map<String, dynamic>? location;
  final List<String>? itemNames;
  
  _MemoryItem({
    required this.id, required this.title, required this.time, 
    required this.icon, required this.color, required this.group,
    required this.category, this.imageUrl, this.isFlagged = false,
    this.personId, this.location, this.itemNames,
  });
}
