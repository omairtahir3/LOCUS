import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_service.dart';
import '../theme/app_theme.dart';

/// Privacy Mode (Module A FE-4 and FE-5, Module 10 FE-3).
///
/// It lives in Settings and nowhere else, by the wearer's choice. It briefly had
/// a cut-down copy on the home screen for FE 10-3's "one-tap access"; that
/// reading of one-tap is now Settings being one tap away, rather than a second
/// copy of the same switch on the screen they see every day.
///
/// Three states rather than a switch, because "stop recording me" and "stop
/// keeping pictures I am recognisable in" are different things to want, and
/// collapsing them would force the stricter one on anybody who only wanted the
/// softer one.
class PrivacyControl extends StatefulWidget {
  const PrivacyControl({super.key});

  @override
  State<PrivacyControl> createState() => _PrivacyControlState();
}

const _modes = [
  ('off', 'Recording', Icons.videocam_outlined,
      'The camera is working normally.'),
  ('blur', 'Blurred', Icons.blur_on,
      'Frames are still kept, pixelated so nobody is recognisable.'),
  ('paused', 'Paused', Icons.videocam_off_outlined,
      'Nothing is recorded and nothing is analysed.'),
];

const _roomLabels = {
  'bathroom': 'Washroom',
  'bedroom': 'Bedroom',
  'kitchen': 'Kitchen',
  'living': 'Living room',
  'dining': 'Dining room',
  'office': 'Office',
};

class _PrivacyControlState extends State<PrivacyControl> {
  Map<String, dynamic>? _p;
  bool _busy = false;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
    // The pipeline switches capture off by itself, so this widget is not the
    // only writer. Polled while on screen so "the washroom is private" shows
    // up without the wearer reopening the page to find out.
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final p = await ApiService.getPrivacy();
      if (mounted && p.isNotEmpty) setState(() => _p = p);
    } catch (_) {
      // Leave whatever was last known on screen rather than blanking it.
    }
  }

  Future<void> _save(Map<String, dynamic> patch) async {
    setState(() => _busy = true);
    final ok = await ApiService.setPrivacy(patch);
    await _load();
    if (!mounted) return;
    setState(() => _busy = false);
    if (!ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not save that. Check the server address.')),
      );
    }
  }

  String? _since(String? iso) {
    if (iso == null) return null;
    final t = DateTime.tryParse(iso);
    if (t == null) return null;
    final mins = DateTime.now().difference(t.toLocal()).inMinutes;
    if (mins < 1) return 'just now';
    if (mins < 60) return '$mins min ago';
    final h = mins ~/ 60;
    return '$h hour${h == 1 ? '' : 's'} ago';
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    if (p == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Text('Loading privacy settings...',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
      );
    }

    final mode = (p['mode'] ?? 'off') as String;
    final current = _modes.firstWhere((m) => m.$1 == mode, orElse: () => _modes.first);
    final rooms = List<String>.from(p['sensitive_rooms'] ?? const []);
    final known = List<String>.from(p['known_rooms'] ?? const []);
    final autoDead = p['auto_dead'] == true;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: _modes.map((m) {
            final on = mode == m.$1;
            return InkWell(
              onTap: (_busy || on) ? null : () => _save({'mode': m.$1}),
              borderRadius: BorderRadius.circular(10),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: on ? AppColors.primaryLight : AppColors.surface,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: on ? AppColors.primary : AppColors.border,
                    width: on ? 2 : 1,
                  ),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Icon(m.$3, size: 16,
                      color: on ? AppColors.primary : AppColors.textSecondary),
                  const SizedBox(width: 8),
                  Text(m.$2, style: TextStyle(
                    fontWeight: FontWeight.w600, fontSize: 13,
                    color: on ? AppColors.primary : AppColors.textSecondary,
                  )),
                ]),
              ),
            );
          }).toList(),
        ),
        const SizedBox(height: 10),
        Text(
          // A wearer who switches this on and forgets is the likeliest way the
          // feature does harm, so how long it has been on is always on screen.
          mode == 'off'
              ? current.$4
              : '${current.$4} Switched on ${_since(p['mode_set_at'] as String?) ?? 'recently'}.',
          style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
        ),
        if (autoDead) ...[
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: AppColors.primaryLight,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(children: [
              const Icon(Icons.shield_outlined, size: 15, color: AppColors.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text('Recording is off right now: ${p['auto_dead_reason'] ?? 'privacy'}',
                    style: const TextStyle(
                        fontSize: 12.5, fontWeight: FontWeight.w600,
                        color: AppColors.primary)),
              ),
            ]),
          ),
        ],
          const SizedBox(height: 20),
          const Text('Rooms to never record in',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
          const SizedBox(height: 6),
          const Text(
            'The camera recognises a room from what is in it. When it sees one '
            'of these it stops recording and destroys anything it had already '
            'kept from that room.',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: known.map((room) {
              final on = rooms.contains(room);
              return InkWell(
                onTap: _busy ? null : () => _save({
                  'sensitive_rooms':
                      on ? (rooms.where((r) => r != room).toList()) : ([...rooms, room]),
                }),
                borderRadius: BorderRadius.circular(20),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                  decoration: BoxDecoration(
                    color: on ? AppColors.primary : AppColors.border,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(_roomLabels[room] ?? room,
                      style: TextStyle(
                        fontSize: 12.5, fontWeight: FontWeight.w600,
                        color: on ? Colors.white : AppColors.textSecondary,
                      )),
                ),
              );
            }).toList(),
          ),
          if ((p['sensitive_places'] as List?)?.isNotEmpty ?? false) ...[
            const SizedBox(height: 20),
            const Text('Places to never record in',
                style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
            const SizedBox(height: 8),
            ...List<Map<String, dynamic>>.from(p['sensitive_places']).map((pl) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(children: [
                    const Icon(Icons.place_outlined, size: 15, color: AppColors.primary),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '${pl['label']?.toString().isNotEmpty == true ? pl['label'] : 'Unnamed place'}'
                        ' · within ${pl['radius_m']} m',
                        style: const TextStyle(fontSize: 12.5),
                      ),
                    ),
                  ]),
                )),
            const SizedBox(height: 4),
            const Text('Places are added from the web app.',
                style: TextStyle(fontSize: 11.5, color: AppColors.textSecondary)),
          ],
      ],
    );
  }
}
