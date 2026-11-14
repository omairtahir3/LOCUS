import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'theme/app_theme.dart';
import 'services/api_service.dart';
import 'services/notification_service.dart';
import 'screens/auth/login_screen.dart';
import 'screens/splash/splash_screen.dart';
import 'screens/auth/register_screen.dart';
import 'screens/home/home_screen.dart';
import 'screens/medication/medication_screen.dart';
import 'screens/activity/activity_screen.dart';
import 'screens/memory/memory_screen.dart';
import 'screens/settings/settings_screen.dart';
import 'screens/caregiver/caregiver_home_screen.dart';
import 'screens/caregiver/family_members_screen.dart';
import 'screens/caregiver/medications_screen.dart';
import 'screens/caregiver/notifications_screen.dart';
import 'screens/caregiver/location_map_screen.dart';
import 'screens/caregiver/activity_feed_screen.dart';

import 'screens/caregiver/keyframe_audit_screen.dart';
import 'screens/memory/past_interactions_screen.dart';
import 'screens/settings/relationships_manage_screen.dart';
import 'screens/items/my_items_screen.dart';
import 'screens/items/item_enroll_screen.dart';
import 'screens/location/my_location_screen.dart';
import 'screens/routine/routine_screen.dart';
import 'services/selected_user_service.dart';
import 'services/fall_detection_service.dart';

import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'widgets/call_overlay.dart';
import 'widgets/tab_bar.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await dotenv.load(fileName: ".env");
  
  if (!kIsWeb) {
    try {
      await Firebase.initializeApp();
      debugPrint('[Firebase] Initialized successfully');
    } catch (e) {
      debugPrint('[Firebase] Initialization failed (missing config?): $e');
    }
  }

  await ApiService.init();
  await NotificationService.init();

  // Setup background message handler
  if (!kIsWeb) {
    try {
      FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
    } catch (e) {
      debugPrint('[FCM] Background handler setup failed: $e');
    }
  }

  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.dark,
  ));

  runApp(const LocusApp());
}

class LocusApp extends StatelessWidget {
  const LocusApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'LOCUS',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      builder: (context, child) {
        // Text scales with the system font setting; icons, switches, buttons
        // and padding beside it do not. Unbounded, that is what pushes a Row
        // past the edge of a 360dp screen -- and it does so on every screen at
        // once, for both roles, which is why it looked like the whole app was
        // broken rather than one layout.
        //
        // Clamped, not ignored. People who need this app often need larger
        // text, so the setting still works up to 1.3x; beyond that a label and
        // its control can no longer share a line, and honouring the request
        // would cost them the control.
        final mq = MediaQuery.of(context);
        return MediaQuery(
          data: mq.copyWith(
            textScaler: mq.textScaler.clamp(maxScaleFactor: 1.3),
          ),
          // A call can arrive on any screen, which is the whole point of it in
          // an emergency, so the overlay sits above the navigator.
          child: CallOverlay(child: child ?? const SizedBox.shrink()),
        );
      },
      initialRoute: '/splash',
      routes: {
        '/splash': (_) => const SplashScreen(),
        '/login': (_) => const LoginScreen(),
        '/register': (_) => const RegisterScreen(),
        '/home': (_) => const MainShell(),
        '/relationships-manage': (_) => const RelationshipsManageScreen(),
        '/my-items': (_) => const MyItemsScreen(),
        '/item-enroll': (_) => const ItemEnrollScreen(),
        '/my-location': (_) => const MyLocationScreen(),
      },
      onGenerateRoute: (settings) {
        if (settings.name == '/past-interactions') {
          final relationshipId = settings.arguments as String;
          return MaterialPageRoute(
            builder: (context) => PastInteractionsScreen(relationshipId: relationshipId),
          );
        }
        return null;
      },
    );
  }
}

// FCM Background handler must be top-level
@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  if (!kIsWeb) {
    await Firebase.initializeApp();
    debugPrint("Handling a background message: ${message.messageId}");
  }
}

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _currentIndex = 0;
  final _medScreenKey = GlobalKey<MedicationScreenState>();
  final _homeScreenKey = GlobalKey<HomeScreenState>();

  @override
  void initState() {
    super.initState();
    _setupFirebaseMessaging();
    if (ApiService.userRole == 'caregiver') {
      SelectedUserService().initialize();
    } else if (ApiService.userRole == 'elderly' && !kIsWeb) {
      FallDetectionService().startListening();
    }
  }

  @override
  void dispose() {
    if (ApiService.userRole == 'elderly' && !kIsWeb) {
      FallDetectionService().stopListening();
    }
    super.dispose();
  }

  Future<void> _setupFirebaseMessaging() async {
    if (kIsWeb) return; // Do not attempt FCM on web

    try {
      final messaging = FirebaseMessaging.instance;
      
      // Request permission
      await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );

      // Get FCM token
      final token = await messaging.getToken();
      if (token != null) {
        debugPrint('[FCM] Token obtained: $token');
        await _sendTokenToBackend(token);
      }

      // Listen for token refreshes
      messaging.onTokenRefresh.listen((newToken) {
        _sendTokenToBackend(newToken);
      });

      // Handle messages when app is in foreground
      FirebaseMessaging.onMessage.listen((RemoteMessage message) {
        if (message.notification != null) {
          NotificationService.showImmediate(
            title: message.notification!.title ?? 'New Alert',
            body: message.notification!.body ?? '',
          );
        }
      });
    } catch (e) {
      debugPrint('[FCM] Setup failed: $e');
    }
  }

  Future<void> _sendTokenToBackend(String token) async {
    try {
      await ApiService.put('/auth/fcm-token', {'token': token});
      debugPrint('[FCM] Token sent to backend successfully');
    } catch (e) {
      debugPrint('[FCM] Failed to send token to backend: $e');
    }
  }

  bool get _isCaregiver => ApiService.userRole == 'caregiver';

  List<Widget> get _screens => _isCaregiver
      ? const [
          FamilyMembersScreen(),
          CaregiverHomeScreen(),
          NotificationsScreen(),
          _MoreScreen(),
        ]
      : [
          // isVisible for the same reason MemoryScreen takes one: an
          // IndexedStack keeps every tab mounted, and the SOS voice listener
          // would otherwise hold the microphone while the person is on
          // another tab trying to use it.
          HomeScreen(key: _homeScreenKey, isVisible: _currentIndex == 0),
          const MyItemsScreen(embedded: true),
          const RelationshipsManageScreen(embedded: true),
          MedicationScreen(key: _medScreenKey),
          const _NormalUserMoreScreen(),
        ];

  /// The four (wearer) and three (caregiver) destinations navItems.js marks
  /// `primary: true`, with the web's own labels. "Home", "Meds" and "Memory"
  /// were this app's words; the product calls them Today, Medication and
  /// Belongings/People.
  List<LocusTab> get _navItems => _isCaregiver
      ? const [
          LocusTab(icon: Icons.family_restroom_outlined, activeIcon: Icons.family_restroom, label: 'Family'),
          LocusTab(icon: Icons.home_outlined, activeIcon: Icons.home, label: 'Today'),
          LocusTab(icon: Icons.notifications_outlined, activeIcon: Icons.notifications, label: 'Alerts'),
          LocusTab(icon: Icons.more_horiz_outlined, activeIcon: Icons.more_horiz, label: 'More'),
        ]
      : const [
          LocusTab(icon: Icons.home_outlined, activeIcon: Icons.home, label: 'Today'),
          LocusTab(icon: Icons.inventory_2_outlined, activeIcon: Icons.inventory_2, label: 'Belongings'),
          LocusTab(icon: Icons.people_outline, activeIcon: Icons.people, label: 'People'),
          LocusTab(icon: Icons.medication_outlined, activeIcon: Icons.medication, label: 'Medication'),
          LocusTab(icon: Icons.more_horiz_outlined, activeIcon: Icons.more_horiz, label: 'More'),
        ];

  @override
  Widget build(BuildContext context) {
    // Clamp index if switching between roles
    if (_currentIndex >= _screens.length) _currentIndex = 0;

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Image.asset('assets/images/logo.png', height: 24),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.notifications_outlined),
            onPressed: () {
              if (_isCaregiver) {
                setState(() => _currentIndex = 2);
              } else {
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (_) => Scaffold(
                      appBar: AppBar(
                        title: const Text('Notifications', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
                      ),
                      body: const NotificationsScreen(),
                    ),
                  ),
                );
              }
            },
          ),
        ],
      ),
      body: IndexedStack(
        index: _currentIndex,
        children: _screens,
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: AppColors.border, width: 1)),
        ),
        child: BottomNavigationBar(
          currentIndex: _currentIndex,
          items: [
            for (final t in _navItems)
              BottomNavigationBarItem(
                  icon: Icon(t.icon), activeIcon: Icon(t.activeIcon), label: t.label),
          ],
          onTap: (i) {
          setState(() => _currentIndex = i);
          // Force active screens to reload when switching to them
            if (!_isCaregiver) {
              if (i == 0) _homeScreenKey.currentState?.reload();
              if (i == 3) _medScreenKey.currentState?.reload();
            }
          },
        ),
      ),
    );
  }
}

// ── More screen (Location, Activity, Settings) ────────────────────────────
class _MoreScreen extends StatelessWidget {
  const _MoreScreen();

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('More', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text('Additional features', style: TextStyle(color: AppColors.textSecondary, fontSize: 14)),
          const SizedBox(height: 20),
          _moreTile(context, Icons.location_on_outlined, 'Location Map', 'Real-time family member tracking', AppColors.info, const LocationMapScreen(), wrapInScaffold: false),
          _moreTile(context, Icons.calendar_month_outlined, 'Routine', "Today's pattern, and the 30-day baseline", AppColors.primary, const RoutineScreen(), wrapInScaffold: false),
          _moreTile(context, Icons.medication_outlined, 'Medication', 'Schedules and adherence history', AppColors.primary, const CaregiverMedicationsScreen()),
          _moreTile(context, Icons.timeline_outlined, 'Activity Feed', 'Behavioral monitoring & analysis', AppColors.accent, const ActivityFeedScreen()),
          _moreTile(context, Icons.search_outlined, 'Memory Search', 'Search memories, interactions & detected objects', AppColors.primary, const MemoryScreen()),
          _moreTile(context, Icons.camera_alt_outlined, 'Keyframe Audit', 'Per-frame AI evidence log', AppColors.accent, const KeyframeAuditScreen(), wrapInScaffold: false),
          _moreTile(context, Icons.settings_outlined, 'Settings', 'Account, notifications & preferences', AppColors.textSecondary, const SettingsScreen()),
        ],
      ),
    );
  }

  Widget _moreTile(BuildContext context, IconData icon, String title, String desc, Color color, Widget screen, {bool wrapInScaffold = true}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        leading: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(12)),
          child: Icon(icon, size: 22, color: color),
        ),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
        subtitle: Text(desc, style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
        trailing: Icon(Icons.chevron_right, color: AppColors.textMuted, size: 20),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => wrapInScaffold ? Scaffold(appBar: AppBar(title: Text(title)), body: screen) : screen)),
      ),
    );
  }
}

// ── Normal user More screen (Keyframe Audit, Settings) ──────────────────
/// Does this wearer have anybody looking after them?
///
/// See the comment at the 'Where I am' tile: absent means unknown, and
/// unknown is treated as linked.
bool _hasCaregiverLink() {
  final cg = ApiService.user?['caregiver_ids'];
  if (cg is! List) return true;
  return cg.isNotEmpty;
}

class _NormalUserMoreScreen extends StatelessWidget {
  const _NormalUserMoreScreen();

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('More', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text('Monitoring & settings', style: TextStyle(color: AppColors.textSecondary, fontSize: 14)),
          const SizedBox(height: 20),
          // Hidden from anyone with no caregiver, so neither half of this
          // screen is offered to somebody it cannot serve: there is nobody for
          // the position to be shared with, and nobody who set a home address
          // for the directions to lead to. The web makes the same cut -- it
          // hides Location from a wearer entirely.
          //
          // The role test alone was not the real condition. It happened to
          // hide this from a 'user' account, which has no caregiver, but it
          // would still have offered it to an 'elderly' account that has none
          // either -- the same empty screen, reached a different way. The
          // condition is the link, so the link is what is tested.
          //
          // An ABSENT caregiver_ids is treated as linked rather than as empty.
          // /auth/me returns the field, but a session restored from an older
          // payload may not carry it, and a missing field is "not known", not
          // "nobody" -- guessing the other way would take this screen off a
          // wearer who does have a caregiver.
          if (ApiService.userRole == 'elderly' && _hasCaregiverLink())
            _tile(context, Icons.place_outlined, 'Where I am', 'Your position, and walking directions home', AppColors.primary, const MyLocationScreen(), wrapInScaffold: false),
          _tile(context, Icons.calendar_month_outlined, 'Routine', "Today's pattern, and what LOCUS has learned", AppColors.primary, const RoutineScreen(), wrapInScaffold: false),
          _tile(context, Icons.timeline_outlined, 'Activity', 'Behavioural monitoring and analysis', AppColors.accent, const ActivityScreen()),
          _tile(context, Icons.search_outlined, 'Memory', 'Search memories, interactions and objects', AppColors.primary, const MemoryScreen()),
          _tile(context, Icons.camera_alt_outlined, 'Keyframe Audit', 'Medicine evidence & AI frames', AppColors.accent, const KeyframeAuditScreen(), wrapInScaffold: false),
          _tile(context, Icons.settings_outlined, 'Settings', 'Account, notifications & preferences', AppColors.textSecondary, const SettingsScreen()),
        ],
      ),
    );
  }

  Widget _tile(BuildContext context, IconData icon, String title, String desc, Color color, Widget screen, {bool wrapInScaffold = true}) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        leading: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(12)),
          child: Icon(icon, size: 22, color: color),
        ),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
        subtitle: Text(desc, style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
        trailing: Icon(Icons.chevron_right, color: AppColors.textMuted, size: 20),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => wrapInScaffold ? Scaffold(appBar: AppBar(title: Text(title)), body: screen) : screen)),
      ),
    );
  }
}
