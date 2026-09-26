// Live verification for SOS bug fix #1: the elderly app's emergency screen
// must clear itself (with a snackbar) when a caregiver resolves the SOS
// remotely, not only when the user taps "I'm Safe Now" locally.
//
// Drives the real running app (logged in as a seeded elderly test account)
// on a real device/emulator, and reaches across to the real backend
// (via the same host:port the app itself talks to, routed through
// `adb reverse tcp:5000 tcp:5000`) to perform the caregiver-side resolve
// exactly as the caregiver's "Acknowledge & Resolve" button would.
//
// Test accounts are seeded ad hoc via /api/auth/register + /api/auth/link-caregiver
// against the locally running backend before this test runs — see
// seed_sos_test_accounts.js. Credentials below are copied from its output.
import 'dart:convert';
// Same as the caregiver test: the widget types used by find.byType come from
// material, which flutter_test does not re-export.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:locus_mobile/main.dart' as app;

const _base = 'http://127.0.0.1:5000/api';
const _caregiverEmail = 'caregiver.1788633110600@test.locus';
const _elderlyEmail = 'elderly1.1788633110600@test.locus';
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

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('elderly emergency screen clears when caregiver resolves remotely', (tester) async {
    app.main();

    // Splash screen holds for a fixed 3s Future.delayed before navigating;
    // its spinner animates continuously so pumpAndSettle alone won't
    // reliably wait it out. Advance real time explicitly instead.
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();

    // ── Log in as the seeded elderly test account ──
    expect(find.byType(TextField), findsNWidgets(2));
    await tester.enterText(find.byType(TextField).at(0), _elderlyEmail);
    await tester.enterText(find.byType(TextField).at(1), _password);
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Sign In'));
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    expect(find.text("I'm Lost / Need Help"), findsOneWidget,
        reason: 'expected to land on the elderly HomeScreen after login');

    // ── Trigger SOS from the real UI (real GPS via emulator geo fix + granted permission) ──
    await tester.tap(find.text("I'm Lost / Need Help"));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    expect(find.text('EMERGENCY ACTIVE'), findsOneWidget,
        reason: 'SOS trigger did not activate the emergency banner');

    // ── Resolve remotely, exactly as the caregiver's "Acknowledge & Resolve" would ──
    final caregiverLogin = await _login(_caregiverEmail, _password);
    final caregiverToken = caregiverLogin['token'] as String;
    final elderlyLogin = await _login(_elderlyEmail, _password);
    final elderlyId = (elderlyLogin['user'] as Map<String, dynamic>)['_id'] as String;

    final resolveRes = await http.delete(
      Uri.parse('$_base/users/$elderlyId/emergency'),
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $caregiverToken'},
    );
    expect(resolveRes.statusCode, 200, reason: 'caregiver-side resolve call failed: ${resolveRes.body}');

    // ── The elderly app should clear on its own, via the real socket broadcast ──
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle(const Duration(milliseconds: 500));

    expect(find.text('EMERGENCY ACTIVE'), findsNothing,
        reason: 'BUG STILL PRESENT: emergency banner did not clear on remote resolve');
    expect(find.textContaining('Your emergency was resolved by'), findsOneWidget,
        reason: 'expected a snackbar confirming the remote resolution');
  });
}
