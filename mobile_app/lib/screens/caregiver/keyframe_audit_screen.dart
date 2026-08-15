import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../theme/app_theme.dart';

class KeyframeAuditScreen extends StatefulWidget {
  const KeyframeAuditScreen({super.key});

  @override
  State<KeyframeAuditScreen> createState() => _KeyframeAuditScreenState();
}

class _KeyframeAuditScreenState extends State<KeyframeAuditScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabCtrl;
  bool _loading = true;
  List<dynamic> _evidence = [];
  List<dynamic> _keyframes = [];
  List<dynamic> _unknownFaces = [];
  String? _expandedEventId;

  @override
  void initState() {
    super.initState();
    _tabCtrl = TabController(length: 3, vsync: this);
    _loadData();
  }

  @override
  void dispose() {
    _tabCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        ApiService.getMedicationFrames(limit: 100),
        ApiService.getKeyframes(limit: 100),
        ApiService.getEventLogKeyframes(type: 'unknown_face', limit: 40),
      ]);
      if (mounted) {
        setState(() {
          _evidence = results[0];
          _keyframes = results[1];
          _unknownFaces = results[2];
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }



  List<Map<String, dynamic>> _groupedEvents() {
    final Map<String, List<Map<String, dynamic>>> groups = {};
    for (final ev in _evidence) {
      final ts = ev['detected_at'] ?? ev['saved_at'] ?? 'unknown';
      groups.putIfAbsent(ts, () => []);
      groups[ts]!.add(Map<String, dynamic>.from(ev));
    }
    final sorted = groups.entries.toList()
      ..sort((a, b) => b.key.compareTo(a.key));

    return sorted.map((entry) {
      final frames = entry.value;
      frames.sort((a, b) {
        const order = {
          'phase1_pill_visible': 0,
          'phase2_grip_motion': 1,
          'phase3_pill_gone': 2,
        };
        return (order[a['phase_role']] ?? 9).compareTo(order[b['phase_role']] ?? 9);
      });
      return {
        'timestamp': entry.key,
        'frames': frames,
        'medication': frames.first['medication_name'] ?? 'Unknown',
        'confidence': frames.first['detection_confidence'] ?? 0.0,
        'status': frames.first['detection_status'] ?? 'unknown',
      };
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Keyframe Audit'),
        bottom: TabBar(
          controller: _tabCtrl,
          indicatorColor: AppColors.primary,
          labelColor: AppColors.primary,
          unselectedLabelColor: AppColors.textSecondary,
          labelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
          tabs: [
            Tab(
              icon: const Icon(Icons.shield_outlined, size: 22),
              text: 'Evidence (${_evidence.isEmpty ? 0 : _groupedEvents().length})',
            ),
            Tab(
              icon: const Icon(Icons.image_outlined, size: 22),
              text: 'Keyframes (${_keyframes.length})',
            ),
            Tab(
              icon: const Icon(Icons.person_outline, size: 22),
              text: 'Unknown Faces (${_unknownFaces.length})',
            ),
          ],
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _loadData,
              child: TabBarView(
                controller: _tabCtrl,
                children: [
                  _buildEvidenceTab(),
                  _buildKeyframesTab(),
                  _buildUnknownFacesTab(),
                ],
              ),
            ),
    );
  }

  // ── Evidence Tab ──────────────────────────────────────────────────────

  Widget _buildEvidenceTab() {
    final events = _groupedEvents();
    if (events.isEmpty) {
      return _emptyState(
        'No evidence frames yet',
        'Evidence is captured when the AI detects medication intake.',
        Icons.shield_outlined,
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: events.length,
      itemBuilder: (ctx, i) => _eventCard(events[i]),
    );
  }

  Widget _eventCard(Map<String, dynamic> event) {
    final frames = event['frames'] as List<Map<String, dynamic>>;
    final ts = event['timestamp'] as String;
    final medication = event['medication'] as String;
    final confidence = ((event['confidence'] as num?) ?? 0).toDouble();
    final status = event['status'] as String;
    final isExpanded = _expandedEventId == ts;

    Color statusColor;
    String statusLabel;
    switch (status) {
      case 'taken':
        statusColor = AppColors.success;
        statusLabel = 'TAKEN';
        break;
      case 'needs_verification':
        statusColor = AppColors.warning;
        statusLabel = 'NEEDS REVIEW';
        break;
      default:
        statusColor = AppColors.textMuted;
        statusLabel = status.toUpperCase();
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: status == 'taken'
              ? AppColors.success.withAlpha(60)
              : status == 'needs_verification'
                  ? AppColors.warning.withAlpha(60)
                  : AppColors.border,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withAlpha(8),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        children: [
          InkWell(
            onTap: () {
              setState(() {
                _expandedEventId = isExpanded ? null : ts;
              });
            },
            borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: status == 'taken'
                            ? [AppColors.success, AppColors.success.withAlpha(180)]
                            : [AppColors.warning, AppColors.warning.withAlpha(180)],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    alignment: Alignment.center,
                    child: Text(
                      '${(confidence * 100).toStringAsFixed(0)}%',
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w800,
                        fontSize: 14,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          medication,
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 14,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _formatTimestamp(ts),
                          style: TextStyle(
                            fontSize: 11,
                            color: AppColors.textMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(
                      color: statusColor.withAlpha(20),
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: statusColor.withAlpha(60)),
                    ),
                    child: Text(
                      statusLabel,
                      style: TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w800,
                        color: statusColor,
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    isExpanded ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                    color: AppColors.textMuted,
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
            child: Row(
              children: frames.map((f) {
                final role = f['phase_role'] ?? '';
                final evId = f['evidence_id'] ?? '';
                return Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 3),
                    child: Column(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: AspectRatio(
                            aspectRatio: 16 / 9,
                            child: Image.network(
                              ApiService.medicationFrameImageUrl(evId),
                              fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) => Container(
                                color: AppColors.borderLight,
                                child: const Icon(Icons.broken_image, size: 24),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _phaseLabel(role),
                          style: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                            color: _phaseColor(role),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              }).toList(),
            ),
          ),
          if (isExpanded) ...[
            const Divider(height: 1, color: AppColors.borderLight),
            ...frames.map((f) => _expandedPhaseCard(f)),
          ],
        ],
      ),
    );
  }

  Widget _expandedPhaseCard(Map<String, dynamic> f) {
    final role = f['phase_role'] ?? '';
    final evId = f['evidence_id'] ?? '';
    final score = ((f['phase_score'] as num?) ?? 0).toDouble();

    return Padding(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: _phaseColor(role).withAlpha(20),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  _phaseLabel(role),
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: _phaseColor(role),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _phaseDescription(role),
                style: TextStyle(fontSize: 11, color: AppColors.textSecondary),
              ),
              const Spacer(),
              Text(
                'Score: ${(score * 100).toStringAsFixed(0)}%',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.network(
              ApiService.medicationFrameImageUrl(evId),
              fit: BoxFit.contain,
              height: 200,
              width: double.infinity,
              errorBuilder: (_, __, ___) => Container(
                height: 200,
                color: AppColors.borderLight,
                alignment: Alignment.center,
                child: const Text('Image unavailable'),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'ID: ${evId.length > 12 ? '${evId.substring(0, 12)}...' : evId}',
            style: TextStyle(fontSize: 9, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }

  // ── Keyframes Tab ─────────────────────────────────────────────────────

  Widget _buildKeyframesTab() {
    if (_keyframes.isEmpty) {
      return _emptyState(
        'No keyframes captured yet',
        'Run the AI detection pipeline to capture keyframes.',
        Icons.image_outlined,
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: _keyframes.length,
      itemBuilder: (ctx, i) {
        final kf = _keyframes[i] as Map<String, dynamic>;
        final kfId = kf['keyframe_id'] as String;
        final isOpen = _expandedEventId == 'kf_$kfId';

        final blurScore = (kf['blur_score'] as num?)?.toDouble() ?? 0.0;
        final motionScore = (kf['motion_score'] as num?)?.toDouble() ?? 0.0;
        final blurObj = _getBlurLabel(blurScore);
        final motionObj = _getMotionLabel(motionScore);

        return Container(
          margin: const EdgeInsets.only(bottom: 10),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            children: [
              InkWell(
                onTap: () {
                  setState(() {
                    _expandedEventId = isOpen ? null : 'kf_$kfId';
                  });
                },
                borderRadius: BorderRadius.circular(14),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      Container(
                        width: 48,
                        height: 48,
                        decoration: BoxDecoration(
                          color: AppColors.borderLight,
                          borderRadius: BorderRadius.circular(8),
                          image: DecorationImage(
                            image: NetworkImage(
                              '${ApiService.baseUrl}/detection/keyframes/$kfId/image',
                            ),
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              kf['saved_at'] != null
                                  ? DateTime.parse(kf['saved_at'])
                                      .toLocal()
                                      .toString()
                                      .substring(0, 16)
                                  : 'Unknown time',
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 12,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${kf['width'] ?? 0}x${kf['height'] ?? 0}',
                              style: TextStyle(
                                fontSize: 10,
                                color: AppColors.textMuted,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Column(
                        children: [
                          _metricPill(
                            'BLUR: ${blurObj['label']}',
                            blurObj['color'] as Color,
                          ),
                          const SizedBox(height: 4),
                          _metricPill(
                            'MOTION: ${motionObj['label']}',
                            motionObj['color'] as Color,
                          ),
                        ],
                      ),
                      const SizedBox(width: 8),
                      Icon(
                        isOpen ? Icons.keyboard_arrow_up : Icons.keyboard_arrow_down,
                        color: AppColors.textMuted,
                      ),
                    ],
                  ),
                ),
              ),
              if (isOpen)
                Container(
                  decoration: const BoxDecoration(
                    border: Border(
                      top: BorderSide(color: AppColors.borderLight),
                    ),
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
                        ),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(
                            'ID: ${kfId.substring(0, 8)}...',
                            style: TextStyle(
                              fontSize: 10,
                              color: AppColors.textSecondary,
                            ),
                          ),
                          Text(
                            'Blur: ${blurScore.toStringAsFixed(1)}',
                            style: TextStyle(
                              fontSize: 10,
                              color: AppColors.textSecondary,
                            ),
                          ),
                          Text(
                            'Motion: ${motionScore.toStringAsFixed(1)}',
                            style: TextStyle(
                              fontSize: 10,
                              color: AppColors.textSecondary,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  // ── Unknown Faces Tab ──────────────────────────────────────────────────

  Widget _buildUnknownFacesTab() {
    if (_unknownFaces.isEmpty) {
      return _emptyState(
        'No unknown faces',
        'When the AI detects an unknown face, it will appear here for verification.',
        Icons.person_search_outlined,
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: _unknownFaces.length,
      itemBuilder: (ctx, i) {
        final ev = _unknownFaces[i];
        final kfId = ev['keyframe_id'];
        final status = ev['verification_status'];

        return Container(
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (kfId != null)
                ClipRRect(
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
                  child: Image.network(
                    '${ApiService.baseUrl}/detection/keyframes/$kfId/image',
                    height: 200,
                    fit: BoxFit.cover,
                    errorBuilder: (c, e, s) => const SizedBox.shrink(),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Unknown Face Detected', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                    const SizedBox(height: 4),
                    Text(_formatTimestamp(ev['timestamp'] ?? ''), style: TextStyle(color: AppColors.textMuted)),
                    const SizedBox(height: 12),
                    
                    if (status == 'pending') ...[
                      Row(
                        children: [
                          Expanded(
                            child: ElevatedButton(
                              style: ElevatedButton.styleFrom(backgroundColor: AppColors.primary),
                              onPressed: () => _showNamePersonDialog(ev['_id']),
                              child: const Text('Name Person', style: TextStyle(color: Colors.white)),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => _dismissFace(ev['_id']),
                              child: const Text('Dismiss'),
                            ),
                          ),
                        ],
                      ),
                    ] else ...[
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(color: AppColors.borderLight, borderRadius: BorderRadius.circular(12)),
                            child: Text(status.toUpperCase(), style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                          ),
                          if (ev['pending_notification'] == true && ApiService.userRole == 'caregiver')
                            Padding(
                              padding: const EdgeInsets.only(left: 8),
                              child: Text('Pending user acknowledgement', style: TextStyle(color: AppColors.warning, fontSize: 12)),
                            ),
                        ],
                      ),
                      if (ev['pending_notification'] == true && ApiService.userRole != 'caregiver') ...[
                        const SizedBox(height: 8),
                        ElevatedButton(
                          onPressed: () => _acknowledgeAction(ev['_id']),
                          child: const Text('Acknowledge Caregiver Action'),
                        ),
                      ],
                    ],
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _showNamePersonDialog(String eventId) async {
    final nameCtrl = TextEditingController();
    final relCtrl = TextEditingController();

    await showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Name this Person'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameCtrl,
              decoration: const InputDecoration(labelText: 'Name', hintText: 'e.g., John Doe'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: relCtrl,
              decoration: const InputDecoration(labelText: 'Relationship (Optional)', hintText: 'e.g., Son'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () async {
              if (nameCtrl.text.isEmpty) return;
              Navigator.pop(context); // Close name dialog
              await _submitFaceConfirm(eventId, nameCtrl.text, relCtrl.text, false, null);
            },
            child: const Text('Confirm'),
          ),
        ],
      ),
    );
  }

  Future<void> _submitFaceConfirm(String eventId, String personName, String relationshipType, bool forceNew, String? mergeInto) async {
    try {
      final res = await ApiService.confirmFace(eventId, personName, relationshipType, forceNew: forceNew, mergeInto: mergeInto);
      
      if (res['statusCode'] == 200) {
        _loadData();
      } else if (res['statusCode'] == 409 && res['data']['duplicates'] != null) {
        final duplicates = res['data']['duplicates'] as List<dynamic>;
        if (mounted) _showDuplicateResolutionDialog(eventId, personName, relationshipType, duplicates);
      } else {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(res['data']['error'] ?? 'Error')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Error confirming face')));
    }
  }

  Future<void> _showDuplicateResolutionDialog(String eventId, String personName, String relationshipType, List<dynamic> duplicates) async {
    await showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Row(
          children: [
            const Icon(Icons.warning_amber_rounded, color: Colors.orange),
            const SizedBox(width: 8),
            const Expanded(child: Text('Duplicate Name Detected', style: TextStyle(fontSize: 18))),
          ],
        ),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'You already have ${duplicates.length} record(s) for "$personName". '
                'Are you confirming the same person from a different angle, or is this a new person who shares the same name?',
                style: const TextStyle(fontSize: 14),
              ),
              const SizedBox(height: 16),
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: duplicates.length,
                  itemBuilder: (ctx, i) {
                    final dup = duplicates[i];
                    return Card(
                      margin: const EdgeInsets.only(bottom: 8),
                      child: ListTile(
                        title: Text('Merge into ${dup['name']}'),
                        subtitle: Text('${dup['relationship_type'] ?? 'No relation'} | Added ${DateTime.parse(dup['createdAt']).toLocal().month}/${DateTime.parse(dup['createdAt']).toLocal().day}'),
                        onTap: () {
                          Navigator.pop(context);
                          _submitFaceConfirm(eventId, personName, relationshipType, false, dup['id']);
                        },
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.white, foregroundColor: Colors.black, side: const BorderSide(color: Colors.grey)),
            onPressed: () {
              Navigator.pop(context);
              _submitFaceConfirm(eventId, personName, relationshipType, true, null);
            },
            child: const Text('Keep Separate (New Person)'),
          ),
        ],
      ),
    );
  }

  Future<void> _dismissFace(String eventId) async {
    try {
      final res = await ApiService.dismissFace(eventId);
      if (res['statusCode'] == 200) {
        _loadData();
      } else {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(res['data']['error'] ?? 'Error')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Error dismissing face')));
    }
  }

  Future<void> _acknowledgeAction(String eventId) async {
    try {
      await ApiService.acknowledgeAction(eventId);
      _loadData();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Error acknowledging action')));
    }
  }


  // ── Helpers ────────────────────────────────────────────────────────────

  Widget _emptyState(String title, String subtitle, IconData icon) {
    return SingleChildScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      child: Container(
        height: MediaQuery.of(context).size.height * 0.65,
        alignment: Alignment.center,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 48, color: AppColors.textMuted),
            const SizedBox(height: 16),
            Text(
              title,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 40),
              child: Text(
                subtitle,
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _metricPill(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(25),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 9,
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }

  String _phaseLabel(String role) {
    switch (role) {
      case 'phase1_pill_visible':
        return 'P1: PILL IN HAND';
      case 'phase2_grip_motion':
        return 'P2: HAND TO MOUTH';
      case 'phase3_pill_gone':
        return 'P3: HAND EMPTY';
      default:
        return role.toUpperCase();
    }
  }

  String _phaseDescription(String role) {
    switch (role) {
      case 'phase1_pill_visible':
        return 'Pill detected in palm area';
      case 'phase2_grip_motion':
        return 'Hand moved toward face';
      case 'phase3_pill_gone':
        return 'Hand returned empty';
      default:
        return '';
    }
  }

  Color _phaseColor(String role) {
    switch (role) {
      case 'phase1_pill_visible':
        return AppColors.primary;
      case 'phase2_grip_motion':
        return AppColors.warning;
      case 'phase3_pill_gone':
        return AppColors.success;
      default:
        return AppColors.textMuted;
    }
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

  String _formatTimestamp(String? raw) {
    if (raw == null) return '—';
    try {
      final dt = DateTime.parse(raw).toLocal();
      final now = DateTime.now();
      final diff = now.difference(dt);
      if (diff.inMinutes < 1) return 'Just now';
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 24) return '${diff.inHours}h ago';
      return dt.toString().substring(0, 16);
    } catch (_) {
      return raw;
    }
  }
}
