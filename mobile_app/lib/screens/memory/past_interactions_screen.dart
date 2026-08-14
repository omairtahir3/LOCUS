import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class PastInteractionsScreen extends StatefulWidget {
  final String relationshipId;

  const PastInteractionsScreen({super.key, required this.relationshipId});

  @override
  State<PastInteractionsScreen> createState() => _PastInteractionsScreenState();
}

class _PastInteractionsScreenState extends State<PastInteractionsScreen> {
  bool _isLoading = true;
  Map<String, dynamic>? _relationship;
  List<dynamic> _interactions = [];

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _isLoading = true);
    try {
      final res = await ApiService.getInteractions(widget.relationshipId);
      if (res['statusCode'] == 200) {
        final data = res['data'];
        setState(() {
          _relationship = data['relationship'];
          _interactions = data['interactions'] ?? [];
        });
      }
    } catch (e) {
      debugPrint('Error loading past interactions: $e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  String _formatDate(String timestamp) {
    final dt = DateTime.parse(timestamp).toLocal();
    final now = DateTime.now();
    final diff = now.difference(dt);

    if (diff.inDays == 0) {
      if (diff.inHours == 0) {
        if (diff.inMinutes == 0) return 'Just now';
        return '${diff.inMinutes}m ago';
      }
      return '${diff.inHours}h ago';
    } else if (diff.inDays == 1) {
      return 'Yesterday';
    } else if (diff.inDays < 7) {
      return '${diff.inDays} days ago';
    } else {
      return '${dt.month}/${dt.day}/${dt.year}';
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(
        backgroundColor: AppColors.background,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    if (_relationship == null) {
      return Scaffold(
        backgroundColor: AppColors.background,
        appBar: AppBar(title: const Text('Person Not Found')),
        body: const Center(child: Text('Could not load relationship details.')),
      );
    }

    final name = _relationship!['person_name'] ?? 'Unknown';
    final initial = name.isNotEmpty ? name[0].toUpperCase() : '?';
    final type = _relationship!['relationship_type'] ?? '';

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Interaction History'),
        backgroundColor: Colors.transparent,
        elevation: 0,
      ),
      body: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Header
              Row(
                children: [
                  CircleAvatar(
                    radius: 32,
                    backgroundColor: AppColors.primary,
                    child: Text(
                      initial,
                      style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(name, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
                        if (type.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text('Relation: $type', style: const TextStyle(fontSize: 14, color: AppColors.textSecondary)),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 32),

              // Timeline Header
              Row(
                children: [
                  const Icon(Icons.calendar_today, color: AppColors.primary, size: 20),
                  const SizedBox(width: 8),
                  Text('Interaction Timeline', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
                ],
              ),
              const SizedBox(height: 16),

              if (_interactions.isEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Column(
                    children: [
                      Icon(Icons.person_outline, size: 48, color: AppColors.textSecondary.withOpacity(0.5)),
                      const SizedBox(height: 16),
                      Text('No past interactions found.', style: const TextStyle(fontSize: 16, color: AppColors.textPrimary)),
                      const SizedBox(height: 8),
                      Text(
                        'When the AI spots $name again, it will appear here.',
                        style: TextStyle(fontSize: 14, color: AppColors.textSecondary),
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                )
              else
                ListView.builder(
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: _interactions.length,
                  itemBuilder: (context, index) {
                    final interaction = _interactions[index];
                    final isLast = index == _interactions.length - 1;
                    
                    return IntrinsicHeight(
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          // Timeline Line and Dot
                          SizedBox(
                            width: 24,
                            child: Stack(
                              alignment: Alignment.topCenter,
                              children: [
                                if (!isLast)
                                  Positioned(
                                    top: 12,
                                    bottom: -24,
                                    child: Container(width: 2, color: AppColors.primary.withOpacity(0.3)),
                                  ),
                                Positioned(
                                  top: 6,
                                  child: Container(
                                    width: 12,
                                    height: 12,
                                    decoration: BoxDecoration(
                                      color: Colors.white,
                                      border: Border.all(color: AppColors.primary, width: 2),
                                      shape: BoxShape.circle,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 12),
                          // Content Card
                          Expanded(
                            child: Padding(
                              padding: const EdgeInsets.only(bottom: 24.0),
                              child: Container(
                                padding: const EdgeInsets.all(16),
                                decoration: BoxDecoration(
                                  color: AppColors.surface,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: AppColors.border),
                                  boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.05), blurRadius: 4, offset: const Offset(0, 2))],
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text('Social Interaction', style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
                                    const SizedBox(height: 4),
                                    Text(_formatDate(interaction['timestamp']), style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                                    
                                    if (interaction['keyframe_id'] != null) ...[
                                      const SizedBox(height: 12),
                                      ClipRRect(
                                        borderRadius: BorderRadius.circular(8),
                                        child: Image.network(
                                          '${ApiService.baseUrl}/detection/keyframes/${interaction['keyframe_id']}/image',
                                          height: 180,
                                          width: double.infinity,
                                          fit: BoxFit.cover,
                                          errorBuilder: (context, error, stackTrace) {
                                            // Image no longer available — show nothing
                                            return const SizedBox.shrink();
                                          },
                                        ),
                                      ),
                                    ]
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}
