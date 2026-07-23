import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  List<dynamic> _notifications = [];
  int _unreadCount = 0;
  bool _loading = true;
  String _filter = 'all';

  List<Map<String, String>> get _filters {
    return [
      {'key': 'all', 'label': 'All'},
      {'key': 'unread', 'label': 'Unread'},
      if (ApiService.userRole != 'caregiver') {'key': 'dose_reminder', 'label': 'Reminders'},
      {'key': 'missed', 'label': 'Missed'},
      {'key': 'camera_off_alert', 'label': 'Camera Off'},
      {'key': 'alerts', 'label': 'Alerts'},
    ];
  }

  static const Map<String, Map<String, dynamic>> _typeConfig = {
    'missed_dose': {'icon': Icons.medication, 'color': AppColors.danger, 'bg': AppColors.dangerLight, 'label': 'Missed Dose'},
    'dose_confirmed': {'icon': Icons.check_circle, 'color': AppColors.success, 'bg': AppColors.successLight, 'label': 'Confirmed'},
    'dose_reminder': {'icon': Icons.notifications, 'color': AppColors.info, 'bg': AppColors.infoLight, 'label': 'Reminder'},
    'camera_off_alert': {'icon': Icons.warning_amber, 'color': AppColors.warning, 'bg': AppColors.warningLight, 'label': 'Camera Off'},
    'emergency': {'icon': Icons.warning_amber, 'color': AppColors.warning, 'bg': AppColors.warningLight, 'label': 'Emergency'},
    'escalated': {'icon': Icons.warning, 'color': AppColors.danger, 'bg': AppColors.dangerLight, 'label': 'Escalated Alert'},
    'status_check': {'icon': Icons.notifications, 'color': AppColors.accent, 'bg': AppColors.accentLight, 'label': 'Status Check'},
    'caregiver_message': {'icon': Icons.message, 'color': AppColors.primary, 'bg': AppColors.primaryLight, 'label': 'Message'},
    'consecutive_misses': {'icon': Icons.error_outline, 'color': AppColors.danger, 'bg': AppColors.dangerLight, 'label': 'Consecutive Misses'},
    'declining_adherence': {'icon': Icons.trending_down, 'color': AppColors.warning, 'bg': AppColors.warningLight, 'label': 'Adherence Alert'},
    'low_confidence_detections': {'icon': Icons.help_outline, 'color': AppColors.warning, 'bg': AppColors.warningLight, 'label': 'Detection Alert'},
  };

  @override
  void initState() {
    super.initState();
    _loadNotifs();
  }

  Future<void> _loadNotifs() async {
    setState(() => _loading = true);
    try {
      final data = await ApiService.getNotificationsData(
        limit: 50,
        unreadOnly: _filter == 'unread',
      );
      setState(() {
        _notifications = data['notifications'] ?? [];
        _unreadCount = data['unread_count'] ?? 0;
      });
    } catch (_) {} finally {
      setState(() => _loading = false);
    }
  }

  List<dynamic> get _filtered {
    if (_filter == 'all' || _filter == 'unread') return _notifications;
    return _notifications.where((n) {
      final t = n['type'] as String? ?? '';
      if (_filter == 'missed') return t == 'missed_dose' || t == 'consecutive_misses';
      if (_filter == 'alerts') return t != 'missed_dose' && t != 'consecutive_misses' && t != 'camera_off_alert' && t != 'dose_reminder';
      return t == _filter;
    }).toList();
  }

  Map<String, dynamic> _getConfig(String? type) {
    return _typeConfig[type] ?? {
      'icon': Icons.notifications_outlined,
      'color': AppColors.textMuted,
      'bg': AppColors.borderLight,
      'label': 'System',
    };
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _loadNotifs,
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
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('Notifications', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 2),
                  Text('$_unreadCount unread', style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
                ]),
                TextButton.icon(
                  onPressed: () async {
                    await ApiService.markAllNotificationsRead();
                    _loadNotifs();
                  },
                  icon: const Icon(Icons.done_all, size: 16),
                  label: const Text('Mark All Read', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Filter chips
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: _filters.map((f) {
                  final isSelected = _filter == f['key'];
                  return Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: FilterChip(
                      selected: isSelected,
                      label: Text(f['label']!),
                      onSelected: (_) {
                        setState(() => _filter = f['key']!);
                        _loadNotifs();
                      },
                      selectedColor: AppColors.primaryLight,
                      checkmarkColor: AppColors.primary,
                      labelStyle: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: isSelected ? AppColors.primary : AppColors.textSecondary,
                      ),
                    ),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 16),

            // Notification list
            if (_loading)
              const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
            else if (_filtered.isEmpty)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(40),
                decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                child: Column(children: [
                  Icon(Icons.notifications_off_outlined, size: 48, color: AppColors.textMuted),
                  const SizedBox(height: 12),
                  Text('No notifications', style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 4),
                  Text("You're all caught up!", style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                ]),
              )
            else
              Container(
                decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: _filtered.asMap().entries.map((entry) {
                    final n = entry.value;
                    final cfg = _getConfig(n['type']);
                    final isUnread = n['is_read'] != true;
                    return Container(
                      decoration: BoxDecoration(
                        color: isUnread ? AppColors.primaryLight.withValues(alpha: 0.3) : null,
                        border: entry.key < _filtered.length - 1 ? const Border(bottom: BorderSide(color: AppColors.borderLight)) : null,
                      ),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          // Icon
                          Container(
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(
                              color: (cfg['bg'] as Color),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Icon(cfg['icon'] as IconData, size: 16, color: cfg['color'] as Color),
                          ),
                          const SizedBox(width: 12),
                          // Body
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(children: [
                                  Expanded(child: Text(n['title'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13))),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                    decoration: BoxDecoration(
                                      color: (cfg['bg'] as Color),
                                      borderRadius: BorderRadius.circular(8),
                                    ),
                                    child: Text(cfg['label'] as String, style: TextStyle(fontSize: 9, fontWeight: FontWeight.w700, color: cfg['color'] as Color)),
                                  ),
                                ]),
                                const SizedBox(height: 4),
                                Text(n['message'] ?? '', style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                                const SizedBox(height: 4),
                                Text(_formatTime(n['createdAt']), style: TextStyle(fontSize: 10, color: AppColors.textMuted)),
                                if (n['escalated'] == true) ...[
                                  const SizedBox(height: 4),
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                    decoration: BoxDecoration(color: AppColors.danger, borderRadius: BorderRadius.circular(6)),
                                    child: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(Icons.warning_amber_rounded, size: 12, color: Colors.white),
                                        SizedBox(width: 4),
                                        Text('ESCALATED', style: TextStyle(fontSize: 9, fontWeight: FontWeight.w800, color: Colors.white)),
                                      ],
                                    ),
                                  ),
                                ],
                                if (n['type'] == 'dose_reminder' && n['is_dismissed'] != true) ...[
                                  const SizedBox(height: 8),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 4,
                                    children: [
                                      if (n['medication_log_id'] != null && ApiService.userRole != 'elderly')
                                        ElevatedButton.icon(
                                          onPressed: () async {
                                            await ApiService.updateLog(n['medication_log_id'], 'taken');
                                            _loadNotifs();
                                          },
                                          icon: const Icon(Icons.check_circle, size: 12),
                                          label: const Text('Take', style: TextStyle(fontSize: 10)),
                                          style: ElevatedButton.styleFrom(backgroundColor: AppColors.success, foregroundColor: Colors.white, minimumSize: const Size(60, 26), padding: const EdgeInsets.symmetric(horizontal: 8)),
                                        ),
                                      OutlinedButton.icon(
                                        onPressed: () async {
                                          await ApiService.snoozeNotification(n['_id'], minutes: 10);
                                          _loadNotifs();
                                        },
                                        icon: const Icon(Icons.snooze, size: 12),
                                        label: const Text('Snooze 10m', style: TextStyle(fontSize: 10)),
                                        style: OutlinedButton.styleFrom(minimumSize: const Size(70, 26), padding: const EdgeInsets.symmetric(horizontal: 8)),
                                      ),
                                    ],
                                  ),
                                ],
                                if (n['type'] == 'status_check' && n['acknowledged_at'] == null) ...[
                                  const SizedBox(height: 8),
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 4,
                                    children: [
                                      ElevatedButton.icon(
                                        onPressed: () async {
                                          await ApiService.respondNotification(n['_id'], "I'm okay, all good!");
                                          _loadNotifs();
                                        },
                                        icon: const Icon(Icons.thumb_up_alt_outlined, size: 12),
                                        label: const Text("I'm Okay", style: TextStyle(fontSize: 10)),
                                        style: ElevatedButton.styleFrom(backgroundColor: AppColors.primary, foregroundColor: Colors.white, minimumSize: const Size(70, 26), padding: const EdgeInsets.symmetric(horizontal: 8)),
                                      ),
                                      OutlinedButton.icon(
                                        onPressed: () async {
                                          await ApiService.respondNotification(n['_id'], "Please call me");
                                          _loadNotifs();
                                        },
                                        icon: const Icon(Icons.phone_outlined, size: 12),
                                        label: const Text("Please Call Me", style: TextStyle(fontSize: 10)),
                                        style: OutlinedButton.styleFrom(minimumSize: const Size(70, 26), padding: const EdgeInsets.symmetric(horizontal: 8)),
                                      ),
                                    ],
                                  ),
                                ],
                              ],
                            ),
                          ),
                          // Actions
                          Column(
                            children: [
                              if (isUnread)
                                IconButton(
                                  icon: const Icon(Icons.done, size: 16),
                                  onPressed: () async {
                                    await ApiService.markNotificationRead(n['_id']);
                                    _loadNotifs();
                                  },
                                  constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                                  padding: EdgeInsets.zero,
                                  tooltip: 'Mark read',
                                ),
                              if (n['requires_acknowledgement'] == true && n['acknowledged_at'] == null)
                                TextButton(
                                  onPressed: () async {
                                    await ApiService.acknowledgeNotification(n['_id']);
                                    _loadNotifs();
                                  },
                                  style: TextButton.styleFrom(
                                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                    minimumSize: Size.zero,
                                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                  child: const Text('Ack', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700)),
                                ),
                              IconButton(
                                icon: Icon(Icons.delete_outline, size: 16, color: AppColors.textMuted),
                                onPressed: () async {
                                  await ApiService.dismissNotification(n['_id']);
                                  _loadNotifs();
                                },
                                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                                padding: EdgeInsets.zero,
                                tooltip: 'Dismiss',
                              ),
                            ],
                          ),
                        ],
                      ),
                    );
                  }).toList(),
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _formatTime(String? raw) {
    if (raw == null) return '';
    try {
      return DateTime.parse(raw).toLocal().toString().substring(0, 16);
    } catch (_) {
      return raw;
    }
  }
}
