import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../widgets/bento.dart';
import '../../widgets/day_summary.dart';
import '../../services/selected_user_service.dart';
import '../../services/api_service.dart';
import '../../services/socket_service.dart';
import '../../services/voice_call_service.dart';
import 'sos_screen.dart';

class CaregiverHomeScreen extends StatefulWidget {
  const CaregiverHomeScreen({super.key});

  @override
  State<CaregiverHomeScreen> createState() => _CaregiverHomeScreenState();
}

class _CaregiverHomeScreenState extends State<CaregiverHomeScreen>
    with WidgetsBindingObserver {
  List<dynamic> _users = [];
  Map<String, dynamic> _summaries = {};
  List<dynamic> _notifications = [];
  bool _loading = true;

  /// Unresolved emergencies, keyed by the id of the person who raised one.
  /// A map rather than a single field because a caregiver may look after more
  /// than one person, and two at once is precisely when nothing may be lost.
  final Map<String, Map<String, dynamic>> _activeSos = {};
  /// Whose SosScreen is already open, so a repeated alert for the same person
  /// refreshes rather than stacking another copy of the same screen.
  String? _sosOnScreen;

  @override
  void initState() {
    super.initState();
    _loadData();

    // Initialize Socket for Caregiver
    SocketService().init();
    // Listening for calls starts where the socket does: a client that is not
    // listening cannot be rung, which is the whole feature.
    VoiceCallService().init();
    SocketService().connect();

    SocketService().addSosAlertListener(_handleSosAlert);
    SocketService().addSosResolvedListener(_handleSosResolved);
    // Anything that happened while the socket was down is read back on the
    // way up, which is exactly when the two dashboards used to disagree.
    SocketService().on('connect', _onSocketUp);
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // See the note on the wearer's screen: the socket does not survive the
    // phone sleeping, and a caregiver coming back to the app is exactly when
    // it matters that it is up. _loadData then reconciles the emergency
    // strips against the server, so anything missed while away is caught.
    if (state == AppLifecycleState.resumed) {
      SocketService().connect();
      _loadData();
    }
  }

  void _onSocketUp(dynamic _) {
    if (mounted) _loadData();
  }

  void _handleSosAlert(Map<String, dynamic> data) {
    if (!mounted) return;
    final id = data['user_id']?.toString();
    if (id == null) return;
    setState(() => _activeSos[id] = data);
    // Straight to that person's screen. A dialog asking whether to look is a
    // question with one answer, and it costs seconds that belong to them.
    _openSos(data);
  }

  Future<void> _openSos(Map<String, dynamic> data) async {
    final id = data['user_id'].toString();
    if (_sosOnScreen == id) return;
    _sosOnScreen = id;
    DateTime? raised;
    final ts = data['timestamp'];
    if (ts is String) raised = DateTime.tryParse(ts)?.toLocal();
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => SosScreen(
          userId: id,
          userName: data['user_name']?.toString() ?? 'Someone you care for',
          initialLocation: (data['location'] as Map?)?.cast<String, dynamic>(),
          raisedAt: raised,
        ),
      ),
    );
    _sosOnScreen = null;
    // Coming back from the screen does not end the emergency; only a
    // resolution does. The strip below keeps it in front of them.
    if (mounted) setState(() {});
  }

  void _handleSosResolved(Map<String, dynamic> data) {
    final id = (data['user_id'] ?? data['userId'])?.toString();
    if (id != null) _activeSos.remove(id);
    if (mounted) {
      setState(() {});
      final resolver = data['resolved_by'] == 'user' ? 'the user themselves' : data['resolver_name'] ?? 'a caregiver';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Emergency for ${data['user_name']} was resolved by $resolver.'),
          backgroundColor: AppColors.success,
          duration: const Duration(seconds: 10),
        )
      );
    }
  }

  @override
  void dispose() {
    SocketService().removeSosAlertListener(_handleSosAlert);
    SocketService().removeSosResolvedListener(_handleSosResolved);
    SocketService().off('connect', _onSocketUp);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
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
      List<dynamic> notifs = [];
      try {
        notifs = await ApiService.getNotifications(limit: 5, unreadOnly: true);
      } catch (_) {}
      // Reconcile the emergency strips against the server rather than
      // trusting the socket events alone. An event missed while the app was
      // backgrounded used to leave a strip up for a resolved emergency, or
      // leave a live one entirely invisible.
      for (final u in users) {
        final id = u['_id']?.toString();
        if (id == null) continue;
        if (u['emergency_status'] == true) {
          _activeSos.putIfAbsent(id, () => <String, dynamic>{
                'user_id': id,
                'user_name': u['name']?.toString() ?? 'Someone you care for',
              });
        } else {
          _activeSos.remove(id);
        }
      }
      setState(() { _users = users; _summaries = summaries; _notifications = notifs; });
    } catch (_) {} finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _clearRecentActivity() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Clear Recent Activity', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
        content: const Text('Are you sure you want to clear all recent activity alerts?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel', style: TextStyle(color: AppColors.textSecondary, fontWeight: FontWeight.w600)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.danger,
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Clear All', style: TextStyle(fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );

    if (confirmed == true && mounted) {
      setState(() {
        _notifications = [];
      });
      try {
        await ApiService.clearAllNotifications();
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Recent activity cleared'),
              backgroundColor: AppColors.success,
              duration: Duration(seconds: 2),
            ),
          );
        }
      } catch (e) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Failed to clear activity: $e'),
              backgroundColor: AppColors.danger,
            ),
          );
          _loadData();
        }
      }
    }
  }

  Widget _sosStrip(Map<String, dynamic> data) {
    final name = data['user_name']?.toString() ?? 'Someone you care for';
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: AppColors.danger,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => _openSos(data),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            child: Row(
              children: [
                const Icon(Icons.warning_amber_rounded,
                    color: Colors.white, size: 28),
                const SizedBox(width: 12),
                // Expanded, so a long name with enlarged system text wraps
                // instead of pushing the chevron off the screen.
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('$name needs help',
                          style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w800,
                              fontSize: 16)),
                      const Text('Tap to open their emergency',
                          style: TextStyle(color: Colors.white70, fontSize: 13)),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: Colors.white),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {

    if (_loading && _users.isEmpty) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary));
    }


    return RefreshIndicator(
      onRefresh: _loadData,
      color: AppColors.primary,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Unresolved emergencies first, always. Anything below this can
            // wait; these cannot, and one raised while the caregiver was
            // reading another would otherwise be invisible.
            // Unresolved emergencies first, always.
            ..._activeSos.values.map(_sosStrip),

            // The whole day for the person currently selected -- the same
            // component the caregiver's web dashboard renders, with canAct so
            // it carries the Location card. Family Status and Live Activity
            // sit below it, exactly as they do on the web: that is the part
            // of this page which is genuinely about everyone.
            // Rebuilt when the selection lands, which is why this is
            // wrapped rather than read once.
            //
            // SelectedUserService().initialize() is started in MainShell's
            // initState and NOT awaited -- it fetches the monitored-users list
            // over the network before it can pick anybody. This page builds
            // long before that returns, so selectedUser was null here and
            // DaySummary loaded with userId: null. With no id the endpoints
            // answer for the CAREGIVER'S own account, and a caregiver has no
            // doses, no rooms and no sightings of their own: every card came
            // back legitimately empty. Next dose was simply the most obvious
            // one, because the wearer's app showed the doses it could not.
            //
            // DaySummary.didUpdateWidget already reloads on a changed userId
            // -- it had no way to hear about this one, because nothing rebuilt
            // this page when the selection arrived. Listening to the service
            // is what connects the two.
            AnimatedBuilder(
              animation: SelectedUserService(),
              builder: (context, _) => DaySummary(
                userId: SelectedUserService().selectedUser?['_id']?.toString(),
                canAct: true,
              ),
            ),
            const SizedBox(height: 14),

            BentoCard(
              icon: Icons.family_restroom_outlined,
              title: 'Family status',
              child: _users.isEmpty
                  ? const CardEmpty(
                      icon: Icons.family_restroom_outlined,
                      text: 'Nobody is linked to this account yet.')
                  : Column(
                      children: _users
                          .asMap()
                          .entries
                          .map((e) => _memberCard(e.key, e.value))
                          .toList(),
                    ),
            ),
            const SizedBox(height: 14),

            BentoCard(
              icon: Icons.notifications_none,
              title: 'Live activity',
              actionLabel: _notifications.isEmpty ? null : 'Clear all',
              onAction: _notifications.isEmpty ? null : _clearRecentActivity,
              child: _notifications.isEmpty
                  ? const CardEmpty(
                      icon: Icons.notifications_none,
                      text: 'Nothing has come in recently.')
                  : Column(
                      children:
                          _notifications.map((n) => _notificationCard(n)).toList(),
                    ),
            ),
          ],
        ),
      ),
    );
  }

      Widget _memberCard(int i, dynamic u) {
    final s = _summaries[u['_id']];
    final adh = (s?['today_adherence']?['adherence_percentage'] ?? 0) as num;
    final colors = [AppColors.primary, AppColors.accent, const Color(0xFFEC4899), const Color(0xFFF59E0B)];
    
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 24,
            backgroundColor: colors[i % colors.length],
            child: Text(u['name']?.toString().substring(0, 1).toUpperCase() ?? '?', 
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 18)),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(u['name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                const SizedBox(height: 2),
                Text(u['email'] ?? '', style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('${adh.toStringAsFixed(0)}%', 
                style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: adh >= 80 ? AppColors.success : AppColors.warning)),
              const Text('Adherence', style: TextStyle(fontSize: 13, color: AppColors.textMuted, fontWeight: FontWeight.w700)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _notificationCard(Map<String, dynamic> n) {
    final type = n['type'] ?? 'system';
    IconData icon = Icons.notifications;
    Color color = AppColors.info;
    if (type == 'missed_dose') { icon = Icons.medication; color = AppColors.danger; }
    else if (type == 'emergency') { icon = Icons.warning; color = AppColors.warning; }

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(16)),
            child: Icon(icon, color: color, size: 20),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(n['title'] ?? '', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14)),
                const SizedBox(height: 4),
                Text(n['message'] ?? '', style: TextStyle(color: AppColors.textSecondary, fontSize: 13, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  }
