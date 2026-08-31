import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import '../chat/chat_screen.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/location_service.dart';
import '../../services/socket_service.dart';
import '../caregiver/location_map_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => HomeScreenState();
}

class HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic>? _summary;
  List<dynamic> _schedule = [];
  bool _loading = true;
  bool _isEmergencyActive = false;

  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    
    // Connect to websocket so Elderly users can chat
    SocketService().init();
    SocketService().connect();
    
    _loadData();
    _refreshTimer = Timer.periodic(const Duration(seconds: 10), (_) => _loadData());
    
    // Start tracking location if elderly or user (normal user)
    if (ApiService.userRole == 'elderly' || ApiService.userRole == 'user') {
      LocationService().startTracking().catchError((e) {
        print("Failed to start location tracking: $e");
      });
    }
  }

  bool get _isElderly => ApiService.userRole == 'elderly';
  bool get _isMonitoredUser => ApiService.userRole == 'elderly' || ApiService.userRole == 'user';

  void reload() => _loadData();

  String _formatTime12h(String? timeStr) {
    if (timeStr == null || timeStr.isEmpty) return '';
    try {
      final parts = timeStr.split(':');
      if (parts.length < 2) return timeStr;
      int hour = int.parse(parts[0]);
      int minute = int.parse(parts[1]);
      final ampm = hour >= 12 ? 'PM' : 'AM';
      if (hour == 0) hour = 12;
      else if (hour > 12) hour -= 12;
      return '$hour:${minute.toString().padLeft(2, '0')} $ampm';
    } catch (_) {
      return timeStr;
    }
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadData() async {
    try {
      final results = await Future.wait([
        ApiService.getAdherenceSummary(),
        ApiService.getSchedule(),
      ]);
      if (mounted) {
        setState(() {
          _summary = results[0] as Map<String, dynamic>;
          _schedule = results[1] as List<dynamic>;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final greeting = now.hour < 12 ? 'Good Morning' : now.hour < 17 ? 'Good Afternoon' : 'Good Evening';
    final firstName = (ApiService.user?['name'] ?? '').toString().split(' ').first;
    final greetingText = firstName.isNotEmpty ? '$greeting $firstName' : greeting;

    return RefreshIndicator(
      onRefresh: _loadData,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Greeting
            Text(greetingText, style: TextStyle(fontSize: 14, color: AppColors.textSecondary, fontWeight: FontWeight.w500)),
            const SizedBox(height: 2),
            Text('Dashboard', style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700)),
            const SizedBox(height: 24),

            // AI Camera Banner
            _buildRtmpBanner(),
            const SizedBox(height: 20),
            
            if (_isElderly)
              _buildSOSSection(),
            if (_isElderly)
              const SizedBox(height: 20),

            if (!_isMonitoredUser)
              _buildCaregiverLocationCard(),
            if (!_isMonitoredUser)
              const SizedBox(height: 20),

            // Stats cards
            _buildStatCards(),
            const SizedBox(height: 20),

            // Upcoming dose
            _buildUpcomingDose(),
            const SizedBox(height: 20),

            // Today's schedule
            _buildScheduleSection(),
          ],
        ),
      ),
    );
  }

  Widget _buildCaregiverLocationCard() {
    return GestureDetector(
      onTap: () {
        Navigator.push(context, MaterialPageRoute(builder: (_) => const LocationMapScreen()));
      },
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.primary.withAlpha(50)),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: AppColors.primary.withAlpha(25), borderRadius: BorderRadius.circular(12)),
              child: const Icon(Icons.map, color: AppColors.primary, size: 28),
            ),
            const SizedBox(width: 16),
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Live Location Map', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  Text('Track family member location', style: TextStyle(color: Colors.grey, fontSize: 13)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: Colors.grey),
          ],
        ),
      ),
    );
  }

  Widget _buildSOSSection() {
    if (_isEmergencyActive) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: AppColors.danger,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: AppColors.danger.withAlpha(100), blurRadius: 20, spreadRadius: 5)
          ],
        ),
        child: Column(
          children: [
            const Icon(Icons.warning_amber_rounded, color: Colors.white, size: 64),
            const SizedBox(height: 12),
            const Text("EMERGENCY ACTIVE", style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w900, letterSpacing: 1.5)),
            const SizedBox(height: 8),
            const Text("Help is on the way. Your caregiver has been notified of your location.", textAlign: TextAlign.center, style: TextStyle(color: Colors.white70, fontSize: 14)),
            const SizedBox(height: 24),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 12,
              runSpacing: 12,
              children: [
                ElevatedButton(
                  onPressed: () async {
                    try {
                      await ApiService.cancelEmergency();
                      if (mounted) setState(() => _isEmergencyActive = false);
                    } catch (e) {
                      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
                    }
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: AppColors.danger,
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
                  ),
                  child: const Text("I'm Safe Now", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                ),
                ElevatedButton.icon(
                  onPressed: () async {
                    final home = ApiService.user?['home_location'];
                    if (home != null && home['lat'] != null && home['lng'] != null) {
                      final url = 'https://www.google.com/maps/dir/?api=1&destination=${home['lat']},${home['lng']}&travelmode=walking';
                      if (await canLaunchUrl(Uri.parse(url))) {
                        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
                      } else {
                        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not launch maps')));
                      }
                    } else {
                      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Home location not set in Settings')));
                    }
                  },
                  icon: const Icon(Icons.home),
                  label: const Text("Take Me Home", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: AppColors.primary,
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              onPressed: () {
                // If there is at least one linked caregiver, open chat with the first one for now
                final caregivers = ApiService.user?['caregiver_ids'];
                if (caregivers != null && caregivers.isNotEmpty) {
                  final firstCaregiverId = caregivers[0] is Map ? caregivers[0]['_id'] : caregivers[0];
                  final caregiverName = caregivers[0] is Map ? caregivers[0]['name'] : 'Caregiver';
                  Navigator.push(context, MaterialPageRoute(builder: (_) => ChatScreen(
                    recipientId: firstCaregiverId,
                    recipientName: caregiverName,
                    isEmergency: true,
                  )));
                } else {
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('No caregivers linked.')));
                }
              },
              icon: const Icon(Icons.chat_bubble_outline),
              label: const Text("Chat with Caregiver", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.surface,
                foregroundColor: AppColors.primary,
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
              ),
            ),
          ],
        ),
      );
    }

    return GestureDetector(
      onTap: () async {
        try {
          final pos = await LocationService().getCurrentPosition();
          if (pos != null) {
            await ApiService.triggerEmergency(pos.latitude, pos.longitude);
            if (mounted) setState(() => _isEmergencyActive = true);
          } else {
            if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not acquire location')));
          }
        } catch (e) {
          if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
        }
      },
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20),
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [AppColors.danger, Color(0xFFD32F2F)]),
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(color: AppColors.danger.withAlpha(80), blurRadius: 15, offset: const Offset(0, 5))
          ],
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: const [
            Icon(Icons.sos, color: Colors.white, size: 36),
            SizedBox(width: 12),
            Text("I'm Lost / Need Help", style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
          ],
        ),
      ),
    );
  }

  Widget _buildRtmpBanner() {
    final host = Uri.parse(ApiService.baseUrl).host;
    final userId = ApiService.user?['_id'] ?? 'unknown';
    final rtmpUrl = 'rtmp://$host/live/$userId';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.primary,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(color: AppColors.primary.withValues(alpha: 0.3), blurRadius: 10, offset: const Offset(0, 4)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.2), shape: BoxShape.circle),
                child: const Icon(Icons.videocam_outlined, color: Colors.white, size: 24),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Text('AI Camera RTMP Link', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Text('Configure your camera (e.g. OBS/GoPro) to stream to:', style: TextStyle(color: Colors.white70, fontSize: 12)),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.2),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(rtmpUrl, style: const TextStyle(color: Colors.white, fontSize: 12, fontFamily: 'monospace')),
                ),
                GestureDetector(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: rtmpUrl));
                    if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('RTMP Link Copied')));
                  },
                  child: const Icon(Icons.copy, color: Colors.white, size: 18),
                )
              ],
            ),
          )
        ],
      ),
    );
  }

  Widget _buildStatCards() {
    final taken = _summary?['taken'] ?? _summary?['counts']?['taken'] ?? 0;
    final missed = _summary?['missed'] ?? _summary?['counts']?['missed'] ?? 0;
    final skipped = _summary?['skipped'] ?? _summary?['counts']?['skipped'] ?? 0;
    final adherence = _summary?['adherence_percentage'] ?? 0;

    return Row(
      children: [
        _statCard('Taken', '$taken', AppColors.success, Icons.check_circle_outline),
        const SizedBox(width: 6),
        _statCard('Missed', '$missed', AppColors.danger, Icons.cancel_outlined),
        const SizedBox(width: 6),
        _statCard('Skipped', '$skipped', AppColors.warning, Icons.warning_amber_outlined),
        const SizedBox(width: 6),
        _statCard('Target', '${adherence is num ? adherence.toStringAsFixed(0) : adherence}%', AppColors.primary, Icons.analytics_outlined),
      ],
    );
  }

  Widget _statCard(String label, String value, Color color, IconData icon) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: color.withAlpha(25),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, size: 18, color: color),
            ),
            const SizedBox(height: 10),
            Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
            Text(label, style: TextStyle(fontSize: 11, color: AppColors.textSecondary, fontWeight: FontWeight.w500)),
          ],
        ),
      ),
    );
  }

  Widget _buildUpcomingDose() {
    final upcoming = _schedule.where((s) => s['status'] == 'scheduled' || s['status'] == 'pending').toList();

    if (upcoming.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: LinearGradient(colors: [AppColors.primary, AppColors.primaryDark]),
          borderRadius: BorderRadius.circular(16),
        ),
        child: const Row(
          children: [
            Icon(Icons.check_circle, color: Colors.white, size: 32),
            SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text("You're all caught up!", style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 16)),
                  Text('No pending medications', style: TextStyle(color: Colors.white70, fontSize: 13)),
                ],
              ),
            ),
          ],
        ),
      );
    }

    final next = upcoming.first;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(colors: [AppColors.primary, AppColors.primaryDark]),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Colors.white.withAlpha(40), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.medication_outlined, color: Colors.white, size: 28),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Next Dose', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(next['medication_name'] ?? 'Medication', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 17))),
                FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text('${next['dosage'] ?? ''} • ${_formatTime12h(next['scheduled_time'] as String?)}', style: const TextStyle(color: Colors.white70, fontSize: 13))),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
            child: Text(_formatTime12h(next['scheduled_time'] as String?), style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700, fontSize: 14)),
          ),
        ],
      ),
    );
  }

  Widget _buildScheduleSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text("Today's Schedule", style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        if (_loading)
          const Center(child: CircularProgressIndicator())
        else if (_schedule.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(32),
            decoration: BoxDecoration(
              color: AppColors.surface, borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.border),
            ),
            child: Column(
              children: [
                Icon(Icons.medication_outlined, size: 40, color: AppColors.textMuted),
                const SizedBox(height: 8),
                Text('No medications today', style: TextStyle(color: AppColors.textSecondary)),
              ],
            ),
          )
        else
          ...List.generate(_schedule.length, (i) {
            final dose = _schedule[i];
            return _doseCard(dose);
          }),
      ],
    );
  }

  Widget _doseCard(Map<String, dynamic> dose) {
    final status = dose['status'] ?? 'scheduled';
    Color statusColor;
    IconData statusIcon;
    switch (status) {
      case 'taken':   statusColor = AppColors.success; statusIcon = Icons.check_circle; break;
      case 'missed':  statusColor = AppColors.danger; statusIcon = Icons.cancel; break;
      case 'snoozed': statusColor = AppColors.warning; statusIcon = Icons.snooze; break;
      default:        statusColor = AppColors.textMuted; statusIcon = Icons.schedule; break;
    }
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: statusColor.withAlpha(25), borderRadius: BorderRadius.circular(8)),
            child: Icon(Icons.medication_outlined, color: statusColor, size: 20),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Expanded(
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.centerLeft,
                        child: Text(
                          dose['medication_name'] ?? 'Medication', 
                          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (status == 'needs_verification')
                      _isMonitoredUser
                        ? Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                            decoration: BoxDecoration(color: AppColors.warning.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.hourglass_top, size: 14, color: AppColors.warning),
                                const SizedBox(width: 4),
                                Text('AWAITING CAREGIVER', style: TextStyle(color: AppColors.warning, fontSize: 9, fontWeight: FontWeight.w800)),
                              ],
                            ),
                          )
                        : Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              GestureDetector(
                                onTap: () => _logDose(dose, 'taken'),
                                child: Container(
                                  padding: const EdgeInsets.all(8),
                                  decoration: BoxDecoration(color: AppColors.success.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                                  child: const Icon(Icons.check, color: AppColors.success, size: 16),
                                ),
                              ),
                              const SizedBox(width: 8),
                              GestureDetector(
                                onTap: () => _logDose(dose, 'scheduled'),
                                child: Container(
                                  padding: const EdgeInsets.all(8),
                                  decoration: BoxDecoration(color: AppColors.danger.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                                  child: const Icon(Icons.close, color: AppColors.danger, size: 16),
                                ),
                              ),
                            ],
                          )
                    else if (status == 'scheduled' || status == 'pending' || status == 'snoozed')
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (!_isMonitoredUser) ...[
                            GestureDetector(
                              onTap: () => _logDose(dose, 'taken'),
                              child: Container(
                                padding: const EdgeInsets.all(6),
                                decoration: BoxDecoration(color: AppColors.success.withAlpha(25), borderRadius: BorderRadius.circular(6)),
                                child: const Icon(Icons.check, color: AppColors.success, size: 16),
                              ),
                            ),
                            const SizedBox(width: 6),
                          ],
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(color: statusColor.withAlpha(25), borderRadius: BorderRadius.circular(6)),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(statusIcon, size: 12, color: statusColor),
                                const SizedBox(width: 4),
                                Text(status.toUpperCase(), style: TextStyle(color: statusColor, fontSize: 10, fontWeight: FontWeight.w700)),
                              ],
                            ),
                          ),
                          const SizedBox(width: 6),
                          GestureDetector(
                            onTap: () async {
                              try {
                                final logId = dose['_id'] ?? dose['id'];
                                if (logId != null) {
                                  await ApiService.snoozeLog(logId.toString(), minutes: 10);
                                  _loadData();
                                }
                              } catch (_) {
                                if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Failed to snooze')));
                              }
                            },
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(color: AppColors.warning.withAlpha(25), borderRadius: BorderRadius.circular(6), border: Border.all(color: AppColors.warning.withAlpha(80))),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.snooze, size: 12, color: AppColors.warning),
                                  const SizedBox(width: 4),
                                  Text('SNOOZE', style: TextStyle(color: AppColors.warning, fontSize: 10, fontWeight: FontWeight.w700)),
                                ],
                              ),
                            ),
                          ),
                        ],
                      )
                    else
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                        decoration: BoxDecoration(color: statusColor.withAlpha(25), borderRadius: BorderRadius.circular(8)),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(statusIcon, size: 14, color: statusColor),
                            const SizedBox(width: 4),
                            Text(status.toUpperCase(), style: TextStyle(color: statusColor, fontSize: 10, fontWeight: FontWeight.w700)),
                          ],
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  '${dose['dosage'] ?? ''} • ${_formatTime12h(dose['scheduled_time'] as String?)}', 
                  style: TextStyle(color: AppColors.textSecondary, fontSize: 11, fontWeight: FontWeight.w500)
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _logDose(Map<String, dynamic> dose, String status) async {
    try {
      final timeParts = (dose['scheduled_time'] as String).split(':');
      final now = DateTime.now();
      final dt = DateTime(now.year, now.month, now.day, int.parse(timeParts[0]), int.parse(timeParts[1]));
      
      await ApiService.recordDose(
        dose['medication_id'] ?? dose['_id'], 
        status,
        dt.toIso8601String()
      );
      _loadData();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Dose marked as $status'), backgroundColor: AppColors.primary),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed: $e'), backgroundColor: AppColors.danger),
        );
      }
    }
  }
}
