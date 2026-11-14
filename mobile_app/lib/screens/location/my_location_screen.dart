import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/api_service.dart';
import '../../services/location_service.dart';
import '../../services/voice_call_service.dart';
import '../../theme/app_theme.dart';

/// The wearer's own location screen.
///
/// "Take me home" existed before this, but only inside the active-emergency
/// panel on the home screen -- so someone who was lost and had not pressed SOS
/// had no way to reach it. Being lost and being in an emergency are not the
/// same state, and the common one had no page.
///
/// Everything here hands off to the Google Maps app rather than drawing a
/// route itself: that is what gives spoken turn-by-turn directions, which is
/// the only form of navigation that is any use to someone who is lost and
/// looking at a phone they cannot read well.
class MyLocationScreen extends StatefulWidget {
  const MyLocationScreen({super.key});

  @override
  State<MyLocationScreen> createState() => _MyLocationScreenState();
}

class _MyLocationScreenState extends State<MyLocationScreen> {
  Position? _position;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _locate();
  }

  Future<void> _locate() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final p = await LocationService().getCurrentPosition();
      if (!mounted) return;
      setState(() {
        _position = p;
        _loading = false;
        // getCurrentPosition returns null both when location is switched off
        // and when permission was refused, and the person can act on either.
        _error = p == null
            ? 'Your phone is not sharing its location. Switch location on in '
                'your phone settings, then press Try again.'
            : null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not find where you are. Press Try again.';
      });
    }
  }

  Map<String, dynamic>? get _home {
    final h = ApiService.user?['home_location'];
    if (h is Map && h['lat'] != null && h['lng'] != null) {
      return Map<String, dynamic>.from(h);
    }
    return null;
  }

  /// Metres from home, or null when either end is unknown.
  double? get _metresFromHome {
    final h = _home;
    final p = _position;
    if (h == null || p == null) return null;
    return Geolocator.distanceBetween(
        p.latitude, p.longitude, (h['lat'] as num).toDouble(), (h['lng'] as num).toDouble());
  }

  Future<void> _open(String url) async {
    final uri = Uri.parse(url);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not open Maps on this phone.')));
    }
  }

  /// Walking directions home, spoken by the Maps app. Same deep link the
  /// emergency panel uses, so there is one way home rather than two.
  void _takeMeHome() {
    final h = _home;
    if (h == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text('No home address is saved yet. A caregiver can set it '
            'in Settings.'),
      ));
      return;
    }
    _open('https://www.google.com/maps/dir/?api=1'
        '&destination=${h['lat']},${h['lng']}&travelmode=walking');
  }

  void _showOnMap() {
    final p = _position;
    if (p == null) return;
    _open('https://www.google.com/maps/search/?api=1'
        '&query=${p.latitude},${p.longitude}');
  }

  Future<void> _callCaregiver() async {
    try {
      final caregivers = await ApiService.getLinkedCaregivers();
      if (caregivers.isEmpty) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('No caregiver is linked to your account yet.')));
        }
        return;
      }
      final c = caregivers.first;
      await VoiceCallService()
          .call(c['_id'].toString(), c['name']?.toString() ?? 'Caregiver');
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Could not start the call: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Where I am')),
      body: RefreshIndicator(
        onRefresh: _locate,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(LocusTokens.space4),
          children: [
            _homeButton(),
            const SizedBox(height: LocusTokens.space4),
            _whereCard(),
            const SizedBox(height: LocusTokens.space4),
            _sharingCard(),
            const SizedBox(height: LocusTokens.space4),
            _callButton(),
            const SizedBox(height: LocusTokens.space5),
          ],
        ),
      ),
    );
  }

  // ── Take me home ────────────────────────────────────────────────────────
  // The one action on this screen that matters, so it is the first thing on
  // it, the width of the screen and tall enough to hit without aiming.
  Widget _homeButton() {
    final hasHome = _home != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 88,
          child: ElevatedButton(
            onPressed: _takeMeHome,
            style: ElevatedButton.styleFrom(
              backgroundColor: hasHome ? AppColors.primary : AppColors.surface2,
              foregroundColor: hasHome ? AppColors.onPrimary : AppColors.textMuted,
              elevation: 0,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(LocusTokens.radiusLg)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.home_rounded, size: 34),
                const SizedBox(width: LocusTokens.space3),
                Flexible(
                  child: Text('Take me home',
                      style: Theme.of(context)
                          .textTheme
                          .headlineSmall
                          ?.copyWith(
                              color: hasHome
                                  ? AppColors.onPrimary
                                  : AppColors.textMuted,
                              fontSize: 24)),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: LocusTokens.space2),
        Text(
          hasHome
              ? 'Opens Maps and speaks the directions out loud as you walk.'
              : 'No home address saved yet. A caregiver can set it in Settings.',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 15, color: AppColors.textSecondary),
        ),
      ],
    );
  }

  // ── Where you are ───────────────────────────────────────────────────────
  Widget _whereCard() {
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _cardTitle(Icons.my_location_rounded, 'Where you are now'),
          const SizedBox(height: LocusTokens.space3),
          if (_loading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: LocusTokens.space5),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_position == null)
            _problem()
          else
            _fix(_position!),
        ],
      ),
    );
  }

  Widget _problem() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(_error ?? 'Could not find where you are.',
            style: const TextStyle(fontSize: 16, color: AppColors.textSecondary)),
        const SizedBox(height: LocusTokens.space3),
        OutlinedButton.icon(
          onPressed: _locate,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again', style: TextStyle(fontSize: 16)),
        ),
      ],
    );
  }

  Widget _fix(Position p) {
    final metres = _metresFromHome;
    final here = LatLng(p.latitude, p.longitude);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Lite mode: a still map rather than a live one. It cannot swallow the
        // page's scroll gesture, and the full map is one tap away in the Maps
        // app, where the controls are big enough to use.
        ClipRRect(
          borderRadius: BorderRadius.circular(LocusTokens.radiusMd),
          child: SizedBox(
            height: 170,
            child: Stack(
              children: [
                GoogleMap(
                  initialCameraPosition: CameraPosition(target: here, zoom: 16),
                  // Lite mode is an Android feature; the web renderer has
                  // no equivalent, so it is asked for only where it exists.
                  liteModeEnabled: !kIsWeb,
                  mapToolbarEnabled: false,
                  zoomControlsEnabled: false,
                  myLocationButtonEnabled: false,
                  markers: {
                    Marker(markerId: const MarkerId('me'), position: here),
                    if (_home != null)
                      Marker(
                        markerId: const MarkerId('home'),
                        position: LatLng((_home!['lat'] as num).toDouble(),
                            (_home!['lng'] as num).toDouble()),
                        icon: BitmapDescriptor.defaultMarkerWithHue(
                            BitmapDescriptor.hueGreen),
                      ),
                  },
                ),
                Positioned.fill(
                  child: Material(
                    color: Colors.transparent,
                    child: InkWell(onTap: _showOnMap),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: LocusTokens.space3),
        if (metres != null)
          Text(
            metres < 60
                ? 'You are at home.'
                : metres < 1000
                    ? 'You are ${metres.round()} metres from home.'
                    : 'You are ${(metres / 1000).toStringAsFixed(1)} km from home.',
            style: const TextStyle(
                fontSize: 19,
                fontWeight: FontWeight.w700,
                color: AppColors.textPrimary),
          ),
        const SizedBox(height: LocusTokens.space1),
        Text(
          '${p.latitude.toStringAsFixed(5)}, ${p.longitude.toStringAsFixed(5)}'
          '  ·  accurate to about ${p.accuracy.round()} m',
          style: const TextStyle(fontSize: 14, color: AppColors.textMuted),
        ),
        const SizedBox(height: LocusTokens.space3),
        OutlinedButton.icon(
          onPressed: _showOnMap,
          icon: const Icon(Icons.map_outlined),
          label: const Text('Open in Maps', style: TextStyle(fontSize: 16)),
        ),
      ],
    );
  }

  // ── What the caregiver can see ──────────────────────────────────────────
  // Said plainly, on the screen that raises the question. A system that
  // reports where someone is should tell them so in words they use.
  Widget _sharingCard() {
    final sharing = _position != null;
    return _card(
      background: sharing ? AppColors.successLight : AppColors.surface2,
      border: sharing ? AppColors.successLight : AppColors.border,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(sharing ? Icons.shield_rounded : Icons.shield_outlined,
              size: 26,
              color: sharing ? AppColors.success : AppColors.textMuted),
          const SizedBox(width: LocusTokens.space3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  sharing
                      ? 'Your caregiver can see where you are'
                      : 'Your caregiver cannot see where you are',
                  style: TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      color:
                          sharing ? AppColors.success : AppColors.textSecondary),
                ),
                const SizedBox(height: LocusTokens.space1),
                Text(
                  sharing
                      ? 'This phone sends your position while you are moving, '
                          'so someone can come and find you.'
                      : 'Switch location on in your phone settings so someone '
                          'can come and find you.',
                  style: const TextStyle(
                      fontSize: 15, color: AppColors.textSecondary),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _callButton() {
    return SizedBox(
      height: 64,
      child: OutlinedButton.icon(
        onPressed: _callCaregiver,
        icon: const Icon(Icons.call_rounded, size: 26),
        label: const Text('Call my caregiver',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
      ),
    );
  }

  // ── Small shared pieces ─────────────────────────────────────────────────
  Widget _card({required Widget child, Color? background, Color? border}) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(LocusTokens.space4),
      decoration: BoxDecoration(
        color: background ?? AppColors.surface,
        borderRadius: BorderRadius.circular(LocusTokens.radiusLg),
        border: Border.all(color: border ?? AppColors.border),
      ),
      child: child,
    );
  }

  Widget _cardTitle(IconData icon, String text) {
    return Row(
      children: [
        Icon(icon, size: 22, color: AppColors.primary),
        const SizedBox(width: LocusTokens.space2),
        Expanded(
          child: Text(text,
              style: const TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary)),
        ),
      ],
    );
  }
}
