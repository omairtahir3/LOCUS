import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'theme/app_theme.dart';
import 'services/api_service.dart';
import 'services/notification_service.dart';
import 'screens/auth/login_screen.dart';
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
import 'screens/caregiver/location_screen.dart';
import 'screens/caregiver/activity_feed_screen.dart';
import 'screens/caregiver/detection_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ApiService.init();
  await NotificationService.init();

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
      initialRoute: ApiService.isLoggedIn ? '/home' : '/login',
      routes: {
        '/login': (_) => const LoginScreen(),
        '/register': (_) => const RegisterScreen(),
        '/home': (_) => const MainShell(),
      },
    );
  }
}

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _currentIndex = 0;

  bool get _isCaregiver => ApiService.userRole == 'caregiver';

  List<Widget> get _screens => _isCaregiver
      ? const [
          CaregiverHomeScreen(),
          FamilyMembersScreen(),
          CaregiverMedicationsScreen(),
          NotificationsScreen(),
          _MoreScreen(),
        ]
      : const [
          HomeScreen(),
          MedicationScreen(),
          ActivityScreen(),
          MemoryScreen(),
          SettingsScreen(),
        ];

  List<BottomNavigationBarItem> get _navItems => _isCaregiver
      ? const [
          BottomNavigationBarItem(icon: Icon(Icons.home_outlined), activeIcon: Icon(Icons.home), label: 'Home'),
          BottomNavigationBarItem(icon: Icon(Icons.family_restroom_outlined), activeIcon: Icon(Icons.family_restroom), label: 'Family'),
          BottomNavigationBarItem(icon: Icon(Icons.medication_outlined), activeIcon: Icon(Icons.medication), label: 'Meds'),
          BottomNavigationBarItem(icon: Icon(Icons.notifications_outlined), activeIcon: Icon(Icons.notifications), label: 'Alerts'),
          BottomNavigationBarItem(icon: Icon(Icons.more_horiz_outlined), activeIcon: Icon(Icons.more_horiz), label: 'More'),
        ]
      : const [
          BottomNavigationBarItem(icon: Icon(Icons.home_outlined), activeIcon: Icon(Icons.home), label: 'Home'),
          BottomNavigationBarItem(icon: Icon(Icons.medication_outlined), activeIcon: Icon(Icons.medication), label: 'Meds'),
          BottomNavigationBarItem(icon: Icon(Icons.timeline_outlined), activeIcon: Icon(Icons.timeline), label: 'Activity'),
          BottomNavigationBarItem(icon: Icon(Icons.search_outlined), activeIcon: Icon(Icons.search), label: 'Memory'),
          BottomNavigationBarItem(icon: Icon(Icons.settings_outlined), activeIcon: Icon(Icons.settings), label: 'Settings'),
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
            onPressed: () {},
          ),
        ],
      ),
      body: IndexedStack(
        index: _currentIndex,
        children: _screens,
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: AppColors.border, width: 1)),
        ),
        child: BottomNavigationBar(
          currentIndex: _currentIndex,
          onTap: (i) => setState(() => _currentIndex = i),
          items: _navItems,
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
          Text('Additional features', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
          const SizedBox(height: 20),
          _moreTile(context, Icons.location_on_outlined, 'Location Map', 'Real-time family member tracking', AppColors.info, const LocationScreen()),
          _moreTile(context, Icons.timeline_outlined, 'Activity Feed', 'Behavioral monitoring & analysis', AppColors.accent, const ActivityFeedScreen()),
          _moreTile(context, Icons.shield_outlined, 'AI Detection', 'Real-time medication intake pipeline', AppColors.info, const DetectionScreen()),
          _moreTile(context, Icons.settings_outlined, 'Settings', 'Account, notifications & preferences', AppColors.textSecondary, const SettingsScreen()),
        ],
      ),
    );
  }

  Widget _moreTile(BuildContext context, IconData icon, String title, String desc, Color color, Widget screen) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(14), border: Border.all(color: AppColors.border)),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        leading: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(12)),
          child: Icon(icon, size: 22, color: color),
        ),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
        subtitle: Text(desc, style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
        trailing: Icon(Icons.chevron_right, color: AppColors.textMuted, size: 20),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => Scaffold(appBar: AppBar(title: Text(title)), body: screen))),
      ),
    );
  }
}
