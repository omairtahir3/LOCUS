import 'dart:async';

import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../../services/api_service.dart';
import '../../services/socket_service.dart';
import '../../services/voice_call_service.dart';
import '../../theme/app_theme.dart';
import '../chat/chat_screen.dart';

/// One emergency, one screen, one person.
///
/// The caregiver side used to hold a single `_sosData` slot shared by everyone
/// they look after, so a second alert overwrote the first and the earlier
/// person simply disappeared from the screen. A caregiver with two people in
/// their care is exactly who this system is for, and losing one of them at the
/// moment both need help is the worst failure it could have.
///
/// So an emergency is addressed to a person. This screen is constructed for
/// one user id and listens only for that id: their location updates move this
/// map and nobody else's, and a resolution elsewhere closes this screen only
/// if it was theirs.
class SosScreen extends StatefulWidget {
  final String userId;
  final String userName;

  /// Where they were when the alert was raised. Live updates refine it; this
  /// is what the map opens on, so it is never blank while waiting.
  final Map<String, dynamic>? initialLocation;
  final DateTime? raisedAt;

  const SosScreen({
    super.key,
    required this.userId,
    required this.userName,
    this.initialLocation,
    this.raisedAt,
  });

  @override
  State<SosScreen> createState() => _SosScreenState();
}

class _SosScreenState extends State<SosScreen> {
  LatLng? _where;
  DateTime? _fixAt;
  bool _resolving = false;
  Timer? _tick;
  GoogleMapController? _map;

  @override
  void initState() {
    super.initState();
    final loc = widget.initialLocation;
    if (loc != null && loc['lat'] != null && loc['lng'] != null) {
      _where = LatLng(
          (loc['lat'] as num).toDouble(), (loc['lng'] as num).toDouble());
      _fixAt = widget.raisedAt;
    }
    SocketService().addLocationUpdateListener(_onLocation);
    SocketService().addSosResolvedListener(_onResolvedElsewhere);
    // Only to re-render "raised 4 minutes ago". Cheap, and the elapsed time is
    // the one number on this screen that changes without an event.
    _tick = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    SocketService().removeLocationUpdateListener(_onLocation);
    SocketService().removeSosResolvedListener(_onResolvedElsewhere);
    super.dispose();
  }

  void _onLocation(Map<String, dynamic> data) {
    // Somebody else's movement is not this emergency.
    if (data['user_id']?.toString() != widget.userId) return;
    final lat = data['lat'], lng = data['lng'];
    if (lat == null || lng == null || !mounted) return;
    final p = LatLng((lat as num).toDouble(), (lng as num).toDouble());
    setState(() {
      _where = p;
      _fixAt = DateTime.now();
    });
    _map?.animateCamera(CameraUpdate.newLatLng(p));
  }

  void _onResolvedElsewhere(Map<String, dynamic> data) {
    final id = (data['user_id'] ?? data['userId'])?.toString();
    // No id means an older server that does not say whose emergency ended;
    // closing on that would dismiss the wrong person's screen, so it stays.
    if (id == null || id != widget.userId || !mounted) return;
    Navigator.of(context).maybePop();
  }

  String get _elapsed {
    final from = widget.raisedAt;
    if (from == null) return '';
    final m = DateTime.now().difference(from).inMinutes;
    if (m < 1) return 'just now';
    if (m == 1) return '1 minute ago';
    if (m < 60) return '$m minutes ago';
    final h = (m / 60).floor();
    return h == 1 ? '1 hour ago' : '$h hours ago';
  }

  Future<void> _resolve() async {
    setState(() => _resolving = true);
    try {
      await http.delete(
        Uri.parse('${ApiService.baseUrl}/users/${widget.userId}/emergency'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ${ApiService.token}',
        },
      );
      if (mounted) Navigator.of(context).maybePop();
    } catch (e) {
      if (mounted) {
        setState(() => _resolving = false);
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Could not mark it resolved: $e')));
      }
    }
  }

  Future<void> _directions() async {
    final p = _where;
    if (p == null) return;
    final url = 'https://www.google.com/maps/dir/?api=1'
        '&destination=${p.latitude},${p.longitude}&travelmode=driving';
    if (await canLaunchUrl(Uri.parse(url))) {
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _where;
    return Scaffold(
      backgroundColor: AppColors.danger,
      appBar: AppBar(
        backgroundColor: AppColors.danger,
        foregroundColor: Colors.white,
        elevation: 0,
        title: Text(widget.userName,
            style: const TextStyle(fontWeight: FontWeight.w900)),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Row(
              children: [
                const Icon(Icons.warning_amber_rounded,
                    color: Colors.white, size: 40),
                const SizedBox(width: 12),
                // Expanded, because a long name plus enlarged system text is
                // exactly what pushed rows off the edge of a 360dp screen.
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('EMERGENCY SOS',
                          style: TextStyle(
                              color: Colors.white,
                              fontSize: 20,
                              fontWeight: FontWeight.w900,
                              letterSpacing: 1.2)),
                      Text(
                        _elapsed.isEmpty
                            ? '${widget.userName} needs help'
                            : '${widget.userName} raised this $_elapsed',
                        style: const TextStyle(color: Colors.white70),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ClipRRect(
              borderRadius:
                  const BorderRadius.vertical(top: Radius.circular(20)),
              child: Container(
                color: AppColors.surface,
                child: p == null
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Text(
                            'No location yet.\nIt will appear here the moment '
                            'their phone reports one.',
                            textAlign: TextAlign.center,
                          ),
                        ),
                      )
                    : GoogleMap(
                        initialCameraPosition:
                            CameraPosition(target: p, zoom: 16),
                        onMapCreated: (c) => _map = c,
                        markers: {
                          Marker(
                            markerId: MarkerId(widget.userId),
                            position: p,
                            infoWindow: InfoWindow(
                              title: widget.userName,
                              snippet: _fixAt == null
                                  ? null
                                  : 'Last seen ${TimeOfDay.fromDateTime(_fixAt!).format(context)}',
                            ),
                          ),
                        },
                        myLocationEnabled: true,
                        zoomControlsEnabled: false,
                      ),
              ),
            ),
          ),
          SafeArea(
            top: false,
            child: Container(
              color: AppColors.surface,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              // Wrap rather than Row: four actions cannot share one line on a
              // narrow phone, and with larger system text they cannot share
              // two. This lets them fall onto as many lines as they need.
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.center,
                children: [
                  _action(Icons.call, 'Call', AppColors.success, () {
                    VoiceCallService()
                        .call(widget.userId, widget.userName, sos: true);
                  }),
                  _action(Icons.chat_bubble_outline, 'Message',
                      AppColors.primary, () {
                    Navigator.push(
                        context,
                        MaterialPageRoute(
                            builder: (_) => ChatScreen(
                                  recipientId: widget.userId,
                                  recipientName: widget.userName,
                                  isEmergency: true,
                                )));
                  }),
                  if (p != null)
                    _action(Icons.directions, 'Directions', AppColors.info,
                        _directions),
                  _action(
                    Icons.check_circle_outline,
                    _resolving ? 'Resolving...' : 'Resolve',
                    AppColors.danger,
                    _resolving ? null : _resolve,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _action(
      IconData icon, String label, Color colour, VoidCallback? onTap) {
    return ElevatedButton.icon(
      onPressed: onTap,
      icon: Icon(icon, size: 18),
      label: Text(label,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
      style: ElevatedButton.styleFrom(
        backgroundColor: colour,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        shape:
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
      ),
    );
  }
}
