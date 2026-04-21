import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../theme/app_theme.dart';

class KeyframeAuditScreen extends StatefulWidget {
  const KeyframeAuditScreen({super.key});

  @override
  State<KeyframeAuditScreen> createState() => _KeyframeAuditScreenState();
}

class _KeyframeAuditScreenState extends State<KeyframeAuditScreen> {
  bool _loading = true;
  List<dynamic> _keyframes = [];
  final Set<String> _expandedIds = {};

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      final kfRes = await ApiService.getKeyframes(limit: 50);
      setState(() {
        _keyframes = kfRes;
        _loading = false;
      });
    } catch (_) {
      setState(() => _loading = false);
    }
  }

  void _toggleExpand(String id) {
    setState(() {
      if (_expandedIds.contains(id)) _expandedIds.remove(id);
      else _expandedIds.add(id);
    });
  }

  Map<String, dynamic> _getBlurLabel(double score) {
    if (score >= 100) return {'label': 'Sharp', 'color': AppColors.success};
    if (score >= 50) return {'label': 'Soft', 'color': AppColors.warning};
    return {'label': 'Blurry', 'color': AppColors.danger};
  }

  Map<String, dynamic> _getMotionLabel(double score) {
    if (score >= 15) return {'label': 'High', 'color': AppColors.danger};
    if (score >= 5) return {'label': 'Medium', 'color': AppColors.warning};
    return {'label': 'Low', 'color': AppColors.textMuted};
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _loadData,
              child: _keyframes.isEmpty
                  ? SingleChildScrollView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      child: Container(
                        height: MediaQuery.of(context).size.height * 0.7,
                        alignment: Alignment.center,
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.image_outlined, size: 48, color: AppColors.textMuted),
                            const SizedBox(height: 16),
                            const Text('No keyframes captured yet', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 8),
                            Text('Run the AI detection pipeline to capture keyframes.', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                          ],
                        ),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.all(16),
                      itemCount: _keyframes.length,
                      itemBuilder: (ctx, i) {
                        final kf = _keyframes[i] as Map<String, dynamic>;
                        final kfId = kf['keyframe_id'] as String;
                        final isOpen = _expandedIds.contains(kfId);
                        
                        // Parse metrics
                        final blurObj = _getBlurLabel((kf['blur_score'] as num?)?.toDouble() ?? 0.0);
                        final motionObj = _getMotionLabel((kf['motion_score'] as num?)?.toDouble() ?? 0.0);

                        return Container(
                          margin: const EdgeInsets.only(bottom: 12),
                          decoration: BoxDecoration(
                            color: AppColors.surface,
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(color: AppColors.border),
                          ),
                          child: Column(
                            key: ValueKey(kfId),
                            children: [
                              InkWell(
                                onTap: () => _toggleExpand(kfId),
                                borderRadius: BorderRadius.circular(14),
                                child: Padding(
                                  padding: const EdgeInsets.all(12),
                                  child: Row(
                                    children: [
                                      // Tiny preview thumbnail
                                      Container(
                                        width: 48,
                                        height: 48,
                                        decoration: BoxDecoration(
                                          color: AppColors.borderLight,
                                          borderRadius: BorderRadius.circular(8),
                                          image: DecorationImage(
                                            image: NetworkImage('${ApiService.baseUrl}/detection/keyframes/$kfId/image'),
                                            fit: BoxFit.cover,
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      // Meta info
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Row(
                                              children: [
                                                const Icon(Icons.access_time, size: 12, color: AppColors.textSecondary),
                                                const SizedBox(width: 4),
                                                Text(
                                                  kf['saved_at'] != null ? DateTime.parse(kf['saved_at']).toLocal().toString().substring(0,16) : 'Unknown time',
                                                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
                                                ),
                                              ],
                                            ),
                                            const SizedBox(height: 2),
                                            Text('${kf['width'] ?? 0}x${kf['height'] ?? 0}', style: TextStyle(fontSize: 10, color: AppColors.textMuted)),
                                          ],
                                        ),
                                      ),
                                      // Metrics pills
                                      Column(
                                        children: [
                                          Container(
                                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                            decoration: BoxDecoration(
                                              color: (blurObj['color'] as Color).withAlpha(25),
                                              borderRadius: BorderRadius.circular(4),
                                            ),
                                            child: Text('BLUR: ${blurObj['label']}', style: TextStyle(fontSize: 9, color: blurObj['color'], fontWeight: FontWeight.w700)),
                                          ),
                                          const SizedBox(height: 4),
                                          Container(
                                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                            decoration: BoxDecoration(
                                              color: (motionObj['color'] as Color).withAlpha(25),
                                              borderRadius: BorderRadius.circular(4),
                                            ),
                                            child: Text('MOTION: ${motionObj['label']}', style: TextStyle(fontSize: 9, color: motionObj['color'], fontWeight: FontWeight.w700)),
                                          ),
                                        ],
                                      ),
                                      const SizedBox(width: 8),
                                      Icon(isOpen ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down, color: AppColors.textMuted),
                                    ],
                                  ),
                                ),
                              ),
                              // Expanded section
                              if (isOpen)
                                Container(
                                  decoration: const BoxDecoration(
                                    border: Border(top: BorderSide(color: AppColors.borderLight)),
                                  ),
                                  padding: const EdgeInsets.all(16),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.stretch,
                                    children: [
                                      ClipRRect(
                                        borderRadius: BorderRadius.circular(8),
                                        child: Image.network(
                                          '${ApiService.baseUrl}/detection/keyframes/$kfId/image',
                                          fit: BoxFit.contain,
                                          height: 250,
                                          alignment: Alignment.center,
                                        ),
                                      ),
                                      const SizedBox(height: 12),
                                      Row(
                                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                        children: [
                                          Text('ID: ${kfId.substring(0, 8)}...', style: TextStyle(fontSize: 10, color: AppColors.textSecondary)),
                                          Text('Blur: ${((kf['blur_score'] as num?)?.toDouble() ?? 0).toStringAsFixed(1)}', style: TextStyle(fontSize: 10, color: AppColors.textSecondary)),
                                          Text('Motion: ${((kf['motion_score'] as num?)?.toDouble() ?? 0).toStringAsFixed(1)}', style: TextStyle(fontSize: 10, color: AppColors.textSecondary)),
                                        ],
                                      ),
                                    ],
                                  ),
                                ),
                            ],
                          ),
                        );
                      },
                    ),
            ),
    );
  }
}
