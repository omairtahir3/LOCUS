import 'dart:convert';
import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import 'item_enroll_screen.dart';

class MyItemsScreen extends StatefulWidget {
  const MyItemsScreen({super.key});

  @override
  State<MyItemsScreen> createState() => _MyItemsScreenState();
}

class _MyItemsScreenState extends State<MyItemsScreen> {
  bool _isLoading = true;
  List<dynamic> _items = [];
  String _searchQuery = '';

  @override
  void initState() {
    super.initState();
    _loadItems();
  }

  Future<void> _loadItems() async {
    setState(() => _isLoading = true);
    try {
      final items = await ApiService.getUserItems();
      if (mounted) {
        setState(() {
          _items = items;
        });
      }
    } catch (e) {
      debugPrint('Error loading user items: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _showRenameDialog(Map<String, dynamic> item) async {
    final controller = TextEditingController(text: item['item_name'] ?? '');
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Rename Item', style: TextStyle(fontWeight: FontWeight.bold)),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(
            labelText: 'Item Name',
            hintText: 'e.g. Grandma\'s Reading Glasses',
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: const Text('Save', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );

    if (confirmed == true && controller.text.trim().isNotEmpty) {
      final newName = controller.text.trim();
      final res = await ApiService.updateUserItem(item['_id'], newName);
      if (res['statusCode'] == 200) {
        _loadItems();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Renamed to "$newName"')),
          );
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to update: ${res['data']?['error'] ?? 'Server error'}')),
          );
        }
      }
    }
  }

  /// What the enrolment is actually worth, said where the enrolling happens.
  ///
  /// A low agreement is NOT a fault once there are enough photographs. Measured
  /// on this account: four photos of a phone agreed at 0.699 and fifteen taken
  /// properly agree at 0.647, and the fifteen are the better gallery. Agreement
  /// falls because the pictures differ, and differing pictures are the point:
  /// the matcher scores a sighting against its single best exemplar.
  ///
  /// What does signal trouble is ONE photograph sitting far from the rest, which
  /// is a blurred shot, a mostly-background shot, or the wrong object in frame.
  /// That is `min`, not `mean`.
  List<Widget> _galleryHealth(Map<String, dynamic> item) {
    final g = item['gallery'];
    if (g is! Map) return const [];
    final photos = (g['photos'] as num?)?.toInt();
    final mean = (g['mean'] as num?)?.toDouble();
    final min = (g['min'] as num?)?.toDouble();
    if (photos == null || mean == null) return const [];

    String text;
    Color colour;
    if (photos < 10) {
      text = '$photos photo${photos == 1 ? '' : 's'}, below the 10 needed';
      colour = AppColors.danger;
    } else if (min != null && min < 0.2) {
      text = '$photos photos, agreement ${mean.toStringAsFixed(2)}, '
          'but one looks unlike the rest (${min.toStringAsFixed(2)})';
      colour = AppColors.warning;
    } else if (mean < 0.35) {
      text = '$photos photos, agreement ${mean.toStringAsFixed(2)}, too scattered';
      colour = AppColors.danger;
    } else {
      text = '$photos photos, agreement ${mean.toStringAsFixed(2)}, a good spread';
      colour = AppColors.success;
    }
    return [
      const SizedBox(height: 6),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(colour == AppColors.success ? Icons.check_circle_outline : Icons.info_outline,
              size: 14, color: colour),
          const SizedBox(width: 5),
          Expanded(
            child: Text(text,
                style: TextStyle(fontSize: 11, color: colour, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    ];
  }

  /// Replace an item's photographs: remove it, then enrol it again.
  ///
  /// There is no way to add photographs to an existing gallery, because an
  /// enrolment is a set taken together in one sitting rather than a pile grown
  /// over time. So improving one means replacing it, and this says so plainly
  /// instead of leaving someone to work out that Remove-then-Add is the route.
  Future<void> _reEnroll(Map<String, dynamic> item) async {
    final name = item['item_name']?.toString() ?? 'this item';
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Re-enrol with new photos'),
        content: Text(
          'This removes the current photographs for "$name" and starts a fresh '
          'enrolment of 10 to 15.\n\n'
          'Its past sightings stay in your timeline, and the routine it has '
          'learned follows the name, so nothing else is lost.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Continue')),
        ],
      ),
    );
    if (go != true || !mounted) return;
    final res = await ApiService.deleteUserItem(item['_id'].toString());
    if (!mounted) return;
    if (res['statusCode'] != 200) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Could not remove it: ${res['data']?['error'] ?? 'server error'}')));
      return;
    }
    await Navigator.pushNamed(context, '/item-enroll');
    if (mounted) _loadItems();
  }

  Future<void> _showDeleteDialog(Map<String, dynamic> item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Row(
          children: [
            Icon(Icons.delete_outline, color: AppColors.danger),
            SizedBox(width: 8),
            Text('Remove Item', style: TextStyle(fontWeight: FontWeight.bold)),
          ],
        ),
        content: Text('Are you sure you want to remove "${item['item_name']}" from your recognized items?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: const Text('Remove', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      final res = await ApiService.deleteUserItem(item['_id']);
      if (res['statusCode'] == 200) {
        _loadItems();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Removed "${item['item_name']}"')),
          );
        }
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Failed to delete: ${res['data']?['error'] ?? 'Server error'}')),
          );
        }
      }
    }
  }

  Widget _buildImageThumbnail(String? base64Str) {
    if (base64Str == null || base64Str.isEmpty) {
      return Container(
        width: 64,
        height: 64,
        decoration: BoxDecoration(
          color: AppColors.primaryLight,
          borderRadius: BorderRadius.circular(14),
        ),
        child: const Icon(Icons.inventory_2_outlined, color: AppColors.primary, size: 30),
      );
    }

    try {
      String cleanB64 = base64Str;
      if (cleanB64.contains(',')) {
        cleanB64 = cleanB64.split(',')[1];
      }
      final bytes = base64Decode(cleanB64);
      return ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Image.memory(
          bytes,
          width: 64,
          height: 64,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: AppColors.primaryLight,
              borderRadius: BorderRadius.circular(14),
            ),
            child: const Icon(Icons.inventory_2_outlined, color: AppColors.primary, size: 30),
          ),
        ),
      );
    } catch (_) {
      return Container(
        width: 64,
        height: 64,
        decoration: BoxDecoration(
          color: AppColors.primaryLight,
          borderRadius: BorderRadius.circular(14),
        ),
        child: const Icon(Icons.inventory_2_outlined, color: AppColors.primary, size: 30),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _items.where((item) {
      final name = (item['item_name'] ?? '').toString().toLowerCase();
      return name.contains(_searchQuery.toLowerCase());
    }).toList();

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Personal Belongings'),
        backgroundColor: Colors.transparent,
        elevation: 0,
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final enrolled = await Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => const ItemEnrollScreen()),
          );
          if (enrolled == true) {
            _loadItems();
          }
        },
        backgroundColor: AppColors.primary,
        icon: const Icon(Icons.add_a_photo_outlined, color: Colors.white),
        label: const Text('Enroll Item', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
      ),
      body: RefreshIndicator(
        onRefresh: _loadItems,
        color: AppColors.primary,
        child: _isLoading
            ? const Center(child: CircularProgressIndicator())
            : Column(
                children: [
                  // Search & Header
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                    child: Column(
                      children: [
                        TextField(
                          onChanged: (v) => setState(() => _searchQuery = v),
                          decoration: InputDecoration(
                            hintText: 'Search belongings & items...',
                            prefixIcon: const Icon(Icons.search, size: 20),
                            contentPadding: const EdgeInsets.symmetric(vertical: 12),
                            filled: true,
                            fillColor: AppColors.surface,
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(16),
                              borderSide: const BorderSide(color: AppColors.border),
                            ),
                            enabledBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(16),
                              borderSide: const BorderSide(color: AppColors.border),
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),
                        Container(
                          padding: const EdgeInsets.all(14),
                          decoration: BoxDecoration(
                            color: AppColors.primaryLight.withOpacity(0.5),
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: AppColors.primary.withOpacity(0.2)),
                          ),
                          child: Row(
                            children: [
                              const Icon(Icons.auto_awesome, color: AppColors.primaryDark, size: 20),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  'Enrolled items are recognized automatically by AI camera and tracked in your Memory Search even after keyframes expire.',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: AppColors.primaryDark,
                                    fontWeight: FontWeight.w500,
                                    height: 1.3,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),

                  // Item list / empty state
                  Expanded(
                    child: filtered.isEmpty
                        ? ListView(
                            physics: const AlwaysScrollableScrollPhysics(),
                            children: [
                              const SizedBox(height: 60),
                              Center(
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.all(24),
                                      decoration: BoxDecoration(
                                        color: AppColors.primaryLight,
                                        shape: BoxShape.circle,
                                      ),
                                      child: const Icon(Icons.inventory_2_outlined, size: 48, color: AppColors.primary),
                                    ),
                                    const SizedBox(height: 16),
                                    Text(
                                      _searchQuery.isNotEmpty ? 'No items match "$_searchQuery"' : 'No items enrolled yet',
                                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16, color: AppColors.textPrimary),
                                    ),
                                    const SizedBox(height: 8),
                                    Padding(
                                      padding: const EdgeInsets.symmetric(horizontal: 40),
                                      child: Text(
                                        _searchQuery.isNotEmpty
                                            ? 'Try searching with another name.'
                                            : 'Enroll keys, glasses, medicine box, watch, wallet, or any personal belonging by taking 3-5 photos from different angles.',
                                        textAlign: TextAlign.center,
                                        style: TextStyle(fontSize: 13, color: AppColors.textSecondary, height: 1.4),
                                      ),
                                    ),
                                    if (_searchQuery.isEmpty) ...[
                                      const SizedBox(height: 24),
                                      ElevatedButton.icon(
                                        onPressed: () async {
                                          final enrolled = await Navigator.push(
                                            context,
                                            MaterialPageRoute(builder: (_) => const ItemEnrollScreen()),
                                          );
                                          if (enrolled == true) {
                                            _loadItems();
                                          }
                                        },
                                        icon: const Icon(Icons.add_a_photo_outlined, color: Colors.white, size: 20),
                                        label: const Text('Enroll First Item', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                                        style: ElevatedButton.styleFrom(
                                          backgroundColor: AppColors.primary,
                                          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ],
                          )
                        : ListView.separated(
                            physics: const AlwaysScrollableScrollPhysics(),
                            padding: const EdgeInsets.fromLTRB(20, 4, 20, 100),
                            itemCount: filtered.length,
                            separatorBuilder: (_, __) => const SizedBox(height: 12),
                            itemBuilder: (context, index) {
                              final item = filtered[index];
                              final name = item['item_name'] ?? 'Unnamed Item';
                              final enrolledBy = item['enrolled_by'] ?? 'user';
                              final createdAt = item['createdAt'];
                              String dateStr = '';
                              if (createdAt != null) {
                                try {
                                  final dt = DateTime.parse(createdAt).toLocal();
                                  dateStr = '${dt.day}/${dt.month}/${dt.year}';
                                } catch (_) {}
                              }

                              return Container(
                                padding: const EdgeInsets.all(16),
                                decoration: BoxDecoration(
                                  color: AppColors.surface,
                                  borderRadius: BorderRadius.circular(20),
                                  border: Border.all(color: AppColors.border),
                                  boxShadow: [
                                    BoxShadow(
                                      color: Colors.black.withOpacity(0.02),
                                      blurRadius: 8,
                                      offset: const Offset(0, 2),
                                    ),
                                  ],
                                ),
                                child: Row(
                                  children: [
                                    _buildImageThumbnail(item['representative_image']),
                                    const SizedBox(width: 16),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            name,
                                            style: const TextStyle(
                                              fontWeight: FontWeight.w700,
                                              fontSize: 16,
                                              color: AppColors.textPrimary,
                                            ),
                                          ),
                                          const SizedBox(height: 6),
                                          Row(
                                            children: [
                                              Container(
                                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                                decoration: BoxDecoration(
                                                  color: enrolledBy == 'caregiver' ? AppColors.accentLight : AppColors.primaryLight,
                                                  borderRadius: BorderRadius.circular(8),
                                                ),
                                                child: Text(
                                                  enrolledBy == 'caregiver' ? 'Caregiver' : 'Personal',
                                                  style: TextStyle(
                                                    fontSize: 11,
                                                    fontWeight: FontWeight.w600,
                                                    color: enrolledBy == 'caregiver' ? AppColors.accent : AppColors.primaryDark,
                                                  ),
                                                ),
                                              ),
                                              if (dateStr.isNotEmpty) ...[
                                                const SizedBox(width: 8),
                                                Text(
                                                  dateStr,
                                                  style: TextStyle(
                                                    fontSize: 12,
                                                    color: AppColors.textMuted,
                                                  ),
                                                ),
                                              ],
                                            ],
                                          ),
                                          // How good the enrolment actually is.
                                          // This existed only on the web, so the
                                          // one place somebody enrols an item was
                                          // the one place they could not see
                                          // whether it had worked.
                                          ..._galleryHealth(item),
                                        ],
                                      ),
                                    ),
                                    PopupMenuButton<String>(
                                      icon: const Icon(Icons.more_vert, color: AppColors.textMuted),
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                                      onSelected: (value) {
                                        if (value == 'rename') {
                                          _showRenameDialog(item);
                                        } else if (value == 'delete') {
                                          _showDeleteDialog(item);
                                        } else if (value == 'reenroll') {
                                          _reEnroll(item);
                                        }
                                      },
                                      itemBuilder: (ctx) => [
                                        const PopupMenuItem(
                                          value: 'rename',
                                          child: Row(
                                            children: [
                                              Icon(Icons.edit_outlined, size: 18, color: AppColors.primary),
                                              SizedBox(width: 10),
                                              Text('Rename'),
                                            ],
                                          ),
                                        ),
                                        const PopupMenuItem(
                                          value: 'reenroll',
                                          child: Row(
                                            children: [
                                              Icon(Icons.photo_camera_outlined, size: 18, color: AppColors.primary),
                                              SizedBox(width: 10),
                                              Text('Re-enrol with new photos'),
                                            ],
                                          ),
                                        ),
                                        const PopupMenuItem(
                                          value: 'delete',
                                          child: Row(
                                            children: [
                                              Icon(Icons.delete_outline, size: 18, color: AppColors.danger),
                                              SizedBox(width: 10),
                                              Text('Remove', style: TextStyle(color: AppColors.danger)),
                                            ],
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                  ),
                ],
              ),
      ),
    );
  }
}
