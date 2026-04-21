import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class FamilyDetailScreen extends StatefulWidget {
  final Map<String, dynamic> user;
  final Map<String, dynamic>? summary;

  const FamilyDetailScreen({super.key, required this.user, this.summary});

  @override
  State<FamilyDetailScreen> createState() => _FamilyDetailScreenState();
}

class _FamilyDetailScreenState extends State<FamilyDetailScreen> {
  List<dynamic> _schedule = [];
  List<dynamic> _history = [];
  List<dynamic> _anomalies = [];
  List<dynamic> _verificationEvents = [];
  List<dynamic> _pendingAlerts = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    try {
      final userId = widget.user['_id'];
      final results = await Future.wait([
        ApiService.getSchedule(userId: userId),
        ApiService.getDoseHistory(userId: userId, limit: 10),
        ApiService.getAnomalies(userId),
        ApiService.getVerificationEvents(userId, limit: 10),
      ]);
      setState(() {
        _schedule = results[0];
        _history = results[1];
        _anomalies = results[2];
        _verificationEvents = results[3];
        _pendingAlerts = (widget.summary?['pending_alerts'] as List?) ?? [];
      });
    } catch (_) {} finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.user['name'] ?? 'User';
    final email = widget.user['email'] ?? '';
    final adh = widget.summary?['today_adherence'];
    final taken = adh?['taken'] ?? 0;
    final missed = adh?['missed'] ?? 0;
    final snoozed = adh?['snoozed'] ?? 0;
    final pct = adh?['adherence_percentage'] ?? 0;

    return Scaffold(
      appBar: AppBar(title: Text(name)),
      body: RefreshIndicator(
        onRefresh: _loadData,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // ── Profile card ──
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                child: Row(
                  children: [
                    CircleAvatar(radius: 28, backgroundColor: AppColors.primary, child: Text(name.substring(0, 1).toUpperCase(), style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700))),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(name, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
                          Text(email, style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),

              // ── Action buttons ──
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => _showSendMessageSheet(context),
                      icon: const Icon(Icons.message_outlined, size: 16),
                      label: const Text('Send Message', style: TextStyle(fontSize: 12)),
                      style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: () => _requestStatusCheck(context),
                      icon: const Icon(Icons.phone_callback_outlined, size: 16),
                      label: const Text('Status Check', style: TextStyle(fontSize: 12)),
                      style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 12), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),

              // ── Today's stats ──
              Row(
                children: [
                  _statChip('Taken', '$taken', AppColors.success),
                  const SizedBox(width: 8),
                  _statChip('Missed', '$missed', AppColors.danger),
                  const SizedBox(width: 8),
                  _statChip('Snoozed', '$snoozed', AppColors.warning),
                  const SizedBox(width: 8),
                  _statChip('Adherence', '${(pct is num ? pct : 0).toStringAsFixed(0)}%', AppColors.primary),
                ],
              ),
              const SizedBox(height: 20),

              // ── Anomaly Alerts ──
              if (_anomalies.isNotEmpty) ...[
                const Text('⚠️ Behavioral Alerts', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                const SizedBox(height: 10),
                ..._anomalies.map((a) => _anomalyCard(a)),
                const SizedBox(height: 20),
              ],

              if (_loading)
                const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
              else ...[
                // ── Today's Schedule ──
                _sectionHeader("Today's Schedule", '${_schedule.length} doses'),
                const SizedBox(height: 10),
                if (_schedule.isEmpty)
                  _emptyCard('No medications scheduled today', Icons.medication_outlined)
                else
                  ..._schedule.map((s) => _scheduleCard(s)),

                const SizedBox(height: 24),

                // ── AI Verification Events ──
                _sectionHeader('🛡️ AI Verification Events', '${_verificationEvents.length} recent'),
                const SizedBox(height: 10),
                if (_verificationEvents.isEmpty)
                  _emptyCard('No AI verification events recorded yet', Icons.shield_outlined)
                else
                  ..._verificationEvents.map((ev) => _verificationCard(ev)),

                const SizedBox(height: 24),

                // ── Pending Alerts ──
                _sectionHeader('🔔 Pending Alerts', '${_pendingAlerts.length} unread'),
                const SizedBox(height: 10),
                if (_pendingAlerts.isEmpty)
                  _emptyCard('No pending alerts for this family member', Icons.check_circle_outline)
                else
                  ..._pendingAlerts.map((a) => _alertCard(a)),

                const SizedBox(height: 24),

                // ── Recent History ──
                _sectionHeader('Recent History', '${_history.length} events'),
                const SizedBox(height: 10),
                if (_history.isEmpty)
                  _emptyCard('No dose history available', Icons.history)
                else
                  ..._history.map((h) => _historyCard(h)),
              ],
            ],
          ),
        ),
      ),
    );
  }

  // ── Anomaly Alert Card ──
  Widget _anomalyCard(Map<String, dynamic> a) {
    final severity = a['severity'] ?? 'info';
    Color color;
    IconData icon;
    switch (severity) {
      case 'critical':
        color = AppColors.danger;
        icon = Icons.warning_amber;
        break;
      case 'warning':
        color = AppColors.warning;
        icon = Icons.trending_down;
        break;
      default:
        color = AppColors.info;
        icon = Icons.remove_red_eye_outlined;
    }
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withValues(alpha: 0.2)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
            child: Icon(icon, size: 20, color: color),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(a['title'] ?? '', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: color)),
                const SizedBox(height: 2),
                Text(a['message'] ?? '', style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
            child: Text(severity.toUpperCase(), style: TextStyle(fontSize: 9, fontWeight: FontWeight.w700, color: color)),
          ),
        ],
      ),
    );
  }

  // ── AI Verification Event Card ──
  Widget _verificationCard(Map<String, dynamic> ev) {
    final confidence = (ev['confidence_score'] as num?) ?? 0;
    final classification = ev['classification'] ?? 'unverified';
    final action = ev['action'] ?? '';

    Color classColor;
    String classLabel;
    if (classification == 'auto_verified') {
      classColor = AppColors.success;
      classLabel = 'Auto Verified';
    } else {
      classColor = AppColors.danger;
      classLabel = 'Unverified';
    }

    String actionLabel;
    switch (action) {
      case 'log_automatically':
        actionLabel = 'Logged automatically';
        break;
      case 'request_user_confirmation':
        actionLabel = 'Awaiting confirmation';
        break;
      default:
        actionLabel = 'Discarded';
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: classification == 'auto_verified'
            ? AppColors.successLight
            : AppColors.dangerLight,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          // Confidence circle
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(color: classColor, borderRadius: BorderRadius.circular(12)),
            alignment: Alignment.center,
            child: Text('${(confidence * 100).toStringAsFixed(0)}%', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13)),
          ),
          const SizedBox(width: 14),
          // Details
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(ev['medication_name'] ?? 'Unknown', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                Text(
                  '${ev['dosage'] ?? ''} • ${_formatTime(ev['scheduled_time'])}',
                  style: TextStyle(fontSize: 11, color: AppColors.textMuted),
                ),
              ],
            ),
          ),
          // Classification badge
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(color: classColor.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(20)),
                child: Text(classLabel, style: TextStyle(fontSize: 9, fontWeight: FontWeight.w700, color: classColor)),
              ),
              const SizedBox(height: 4),
              Text(actionLabel, style: TextStyle(fontSize: 9, color: AppColors.textMuted)),
            ],
          ),
        ],
      ),
    );
  }

  // ── Alert Card ──
  Widget _alertCard(Map<String, dynamic> a) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.dangerLight,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.danger.withValues(alpha: 0.15)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: AppColors.danger.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(8)),
            child: const Icon(Icons.warning_amber, size: 16, color: AppColors.danger),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(a['title'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                Text(a['message'] ?? '', style: TextStyle(fontSize: 11, color: AppColors.textSecondary), maxLines: 2, overflow: TextOverflow.ellipsis),
                Text(_formatTime(a['createdAt']), style: TextStyle(fontSize: 10, color: AppColors.textMuted)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ── Schedule Card ──
  Widget _scheduleCard(Map<String, dynamic> s) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: AppColors.border)),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: AppColors.primaryLight, borderRadius: BorderRadius.circular(8)),
            child: Icon(Icons.medication, size: 18, color: AppColors.primary),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s['medication_name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                Text('${s['dosage'] ?? ''} • ${s['scheduled_time'] ?? ''}', style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
              ],
            ),
          ),
          _statusChip(s['status'] ?? 'scheduled'),
        ],
      ),
    );
  }

  // ── History Card ──
  Widget _historyCard(Map<String, dynamic> h) {
    final confidence = h['confidence_score'];
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(10), border: Border.all(color: AppColors.borderLight)),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  h['medication_name'] ?? (h['medication_id'] is Map ? h['medication_id']['name'] : null) ?? '—',
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                ),
                Text(_formatTime(h['scheduled_time'] ?? h['createdAt']), style: TextStyle(fontSize: 10, color: AppColors.textMuted)),
              ],
            ),
          ),
          if (confidence != null)
            Padding(
              padding: const EdgeInsets.only(right: 10),
              child: Text('${((confidence as num) * 100).toStringAsFixed(0)}%', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
            ),
          _statusChip(h['status'] ?? 'scheduled'),
        ],
      ),
    );
  }

  // ── Helpers ──

  Widget _sectionHeader(String title, String subtitle) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
        Text(subtitle, style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
      ],
    );
  }

  void _showSendMessageSheet(BuildContext context) {
    final titleCtrl = TextEditingController();
    final msgCtrl = TextEditingController();
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(20, 20, 20, MediaQuery.of(ctx).viewInsets.bottom + 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Send Message to ${widget.user['name']}', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            const SizedBox(height: 16),
            TextField(controller: titleCtrl, decoration: const InputDecoration(hintText: 'Title', contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12))),
            const SizedBox(height: 10),
            TextField(controller: msgCtrl, maxLines: 3, decoration: const InputDecoration(hintText: 'Type your message...', contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12))),
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
                const SizedBox(width: 8),
                ElevatedButton.icon(
                  onPressed: () async {
                    if (titleCtrl.text.isEmpty || msgCtrl.text.isEmpty) return;
                    try {
                      await ApiService.sendMessage(widget.user['_id'], titleCtrl.text, msgCtrl.text);
                      if (ctx.mounted) Navigator.pop(ctx);
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Message sent!')));
                        _loadData();
                      }
                    } catch (_) {
                      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Failed to send message')));
                    }
                  },
                  icon: const Icon(Icons.send, size: 16),
                  label: const Text('Send'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _requestStatusCheck(BuildContext context) async {
    try {
      await ApiService.statusCheck(widget.user['_id']);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Status check request sent!')));
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Failed to send status check')));
    }
  }

  Widget _statChip(String label, String value, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(12)),
        child: Column(
          children: [
            Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: color)),
            Text(label, style: TextStyle(fontSize: 10, color: AppColors.textSecondary)),
          ],
        ),
      ),
    );
  }

  Widget _statusChip(String status) {
    final colors = {'taken': AppColors.success, 'missed': AppColors.danger, 'snoozed': const Color(0xFFF59E0B), 'needs_verification': AppColors.warning};
    final c = colors[status] ?? AppColors.textMuted;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(20)),
      child: Text(status.toUpperCase(), style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: c)),
    );
  }

  Widget _emptyCard(String text, IconData icon) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: AppColors.border)),
      child: Column(
        children: [
          Icon(icon, size: 36, color: AppColors.textMuted),
          const SizedBox(height: 8),
          Text(text, style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
        ],
      ),
    );
  }

  String _formatTime(String? raw) {
    if (raw == null) return '—';
    try { return DateTime.parse(raw).toLocal().toString().substring(0, 16); } catch (_) { return raw; }
  }
}
