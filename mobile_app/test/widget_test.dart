/// The app starts, and gets past its splash screen.
///
/// This used to pump LocusApp and assert a MaterialApp existed, which failed:
/// SplashScreen.initState starts a 3 s timer to navigate, and a test that ends
/// with a timer still pending is a failure, however harmless the timer is. The
/// fix is not to silence it but to let it run, which also makes the test say
/// something worth knowing -- that an unauthenticated start lands on login.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:locus_mobile/main.dart';
import 'package:locus_mobile/screens/auth/login_screen.dart';
import 'package:locus_mobile/screens/splash/splash_screen.dart';
import 'package:locus_mobile/services/api_service.dart';

/// Answers every request with an empty 200 instead of letting it out. The login
/// screen draws a logo with Image.network, and an unhandled failure there is
/// reported as a test exception that has nothing to do with what is being tested.
class _OfflineHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _OfflineClient();
}

class _OfflineClient implements HttpClient {
  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async => _OfflineRequest();
  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _OfflineRequest implements HttpClientRequest {
  @override
  final HttpHeaders headers = _OfflineHeaders();
  @override
  Future<void> addStream(Stream<List<int>> stream) async {}
  @override
  Future<HttpClientResponse> close() async => _OfflineResponse();
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _OfflineHeaders implements HttpHeaders {
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}
  @override
  void forEach(void Function(String name, List<String> values) action) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _OfflineResponse extends Stream<List<int>> implements HttpClientResponse {
  @override
  int get statusCode => 200;
  @override
  int get contentLength => 0;
  @override
  bool get isRedirect => false;
  @override
  String get reasonPhrase => 'OK';
  @override
  HttpHeaders get headers => _OfflineHeaders();
  @override
  StreamSubscription<List<int>> listen(void Function(List<int>)? onData,
          {Function? onError, void Function()? onDone, bool? cancelOnError}) =>
      const Stream<List<int>>.empty()
          .listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await ApiService.init();
    HttpOverrides.global = _OfflineHttpOverrides();
  });

  tearDown(() => HttpOverrides.global = null);

  testWidgets('the app starts on the splash screen', (tester) async {
    await tester.pumpWidget(const LocusApp());
    expect(find.byType(MaterialApp), findsOneWidget);
    expect(find.byType(SplashScreen), findsOneWidget);

    // Drained after the assertion, not before it: the splash timer is started in
    // initState, and a test that finishes with a timer pending fails whatever it
    // was checking.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });

  testWidgets('with no session it moves on to login', (tester) async {
    await tester.pumpWidget(const LocusApp());
    expect(ApiService.isLoggedIn, isFalse, reason: 'no token was stored');

    // Past the splash delay. Leaving this timer pending is what made the old
    // version of this test fail.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.byType(SplashScreen), findsNothing,
        reason: 'pushReplacementNamed, so the splash is gone and not stacked');
  });
}
