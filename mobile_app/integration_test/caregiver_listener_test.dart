// Live verification for SOS bug fix #2: SocketService previously exposed
// single overwritable callback fields (onSosAlert/onSosResolved/onLocationUpdate).
// LocationMapScreen.dispose() nulled all three unconditionally, so once a
// caregiver opened the location/chat screen from an SOS dialog and navigated
// back, CaregiverHomeScreen's own listeners were gone — later SOS alerts were
// silently dropped until the app was fully restarted. SocketService was
// refactored to per-event listener lists so each screen add/remove only its
// own subscription.
//
// Drives the real running app (logged in as a seeded caregiver test account)
// on a real device/emulator. The two elderly-side SOS triggers are performed
// as raw API calls (impersonating the elderly device at the protocol level,
// exactly what a second physical device would send) so a single emulator can
// exercise the full caregiver-side listener lifecycle bug.
import 'dart:convert';
// find.byType(TextField) and find.byType(ElevatedButton) below need the widget
// classes themselves. flutter_test does not re-export them, so without this the
// file does not compile and the whole test was unrunnable rather than failing.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:locus_mobile/main.dart' as app;

const _base = 'http://127.0.0.1:5000/api';
const _caregiverEmail = 'caregiver.1788633110600@test.locus';
const _elderly1Email = 'elderly1.1788633110600@test.locus';
const _elderly2Email = 'elderly2.1788633110600@test.locus';
const _password = 'Passw0rd!123';

Future<Map<String, dynamic>> _login(String email, String password) async {
  final res = await http.post(
    Uri.parse('$_base/auth/login'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'email': email, 'password': password}),
  );
  expect(res.statusCode, 200, reason: 'login failed for $email: ${res.body}');
  return jsonDecode(res.body) as Map<String, dynamic>;
}

Future<void> _triggerSos(String elderlyToken) async {
  final res = await http.post(
    Uri.parse('$_base/users/me/emergency'),
    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $elderlyToken'},
    body: jsonEncode({'lat': 37.4219, 'lng': -122.084}),
  );
  expect(res.statusCode, 200, reason: 'SOS trigger failed: ${res.body}');
}

Future<void> _resolveSos(String elderlyId, String caregiverToken) async {
  await http.delete(
    Uri.parse('$_base/users/$elderlyId/emergency'),
    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $caregiverToken'},
  );
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('caregiver still receives a second SOS after visiting LocationMapScreen and back', (tester) async {
    final caregiverLogin = await _login(_caregiverEmail, _password);
    final caregiverToken = caregiverLogin['token'] as String;
    final elderly1Login = await _login(_elderly1Email, _password);
    final elderly1Id = (elderly1Login['user'] as Map<String, dynamic>)['_id'] as String;
    final elderly2Login = await _login(_elderly2Email, _password);
    final elderly2Id = (elderly2Login['user'] as Map<String, dynamic>)['_id'] as String;

    // Clean slate in case a previous run left either account mid-emergency.
    await _resolveSos(elderly1Id, caregiverToken);
    await _resolveSos(elderly2Id, caregiverToken);

    app.main();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();

    // ── Log in as the seeded caregiver test account ──
    await tester.enterText(find.byType(TextField).at(0), _caregiverEmail);
    await tester.enterText(find.byType(TextField).at(1), _password);
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Sign In'));
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    // CaregiverHomeScreen sits in the MainShell's IndexedStack, so its
    // initState (and our listener registration) has already run.
    expect(find.text('Your care network is active.'), findsOneWidget,
        reason: 'expected to land on CaregiverHomeScreen after login');

    // ── First SOS, from elderly #2 ──
    await _triggerSos(elderly2Login['token'] as String);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    expect(find.text('EMERGENCY SOS'), findsOneWidget,
        reason: 'first SOS alert dialog did not appear');

    // ── Navigate into LocationMapScreen + ChatScreen (as the dialog's button does), then back out ──
    await tester.tap(find.text('VIEW LOCATION & CHAT'));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    await tester.pageBack(); // ChatScreen -> LocationMapScreen
    await tester.pumpAndSettle(const Duration(milliseconds: 500));
    await tester.pageBack(); // LocationMapScreen -> CaregiverHomeScreen
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    expect(find.text('Your care network is active.'), findsOneWidget,
        reason: 'expected to be back on CaregiverHomeScreen');

    await _resolveSos(elderly2Id, caregiverToken);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    // ── Second SOS, from elderly #1 — this is the regression check ──
    await _triggerSos(elderly1Login['token'] as String);
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    expect(find.text('EMERGENCY SOS'), findsOneWidget,
        reason: 'BUG STILL PRESENT: second SOS alert was silently dropped after '
            'visiting LocationMapScreen and back — CaregiverHomeScreen\'s listener '
            'was wiped by LocationMapScreen.dispose()');

    // Cleanup.
    await _resolveSos(elderly1Id, caregiverToken);
  });
}
