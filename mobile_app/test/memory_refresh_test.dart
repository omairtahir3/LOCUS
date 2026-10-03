/// The memory list refreshes itself, and only when that is worth doing.
///
/// The web polls every 15 s so a sighting logged while the page is open shows up;
/// the phone did not, and went stale until the tab was tapped again. The risk in
/// copying it is that the bottom nav hosts these screens in an IndexedStack,
/// which keeps every tab mounted, so a naive timer polls while the user is on
/// Home and spends their battery and data on nothing.
///
/// So what is asserted here is the GATE, not the fetch: who polls, who does not,
/// and that it stops. Requests are counted by replacing the HTTP client, because
/// the number of requests is the whole point.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:locus_mobile/screens/memory/memory_screen.dart';
import 'package:locus_mobile/services/api_service.dart';

/// Counts calls instead of making them. Every request answers with an empty
/// JSON list, which is what the screen expects of a day with no memories.
class _CountingHttpOverrides extends HttpOverrides {
  int memorySearchCalls = 0;

  @override
  HttpClient createHttpClient(SecurityContext? context) => _CountingClient(this);
}

class _CountingClient implements HttpClient {
  _CountingClient(this.owner);
  final _CountingHttpOverrides owner;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    if (url.path.contains('memory-search')) owner.memorySearchCalls++;
    return _FakeRequest();
  }

  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);

  // Returns null rather than deferring to super, which throws. The http client
  // calls close(force: true) and a handful of setters that this fake has no
  // opinion about, and every one of them was failing the test.
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeRequest implements HttpClientRequest {
  @override
  final HttpHeaders headers = _FakeHeaders();

  // IOClient does `stream.pipe(ioRequest)`, which is addStream followed by
  // close. Without addStream the pipe got null where it awaited a Future.
  @override
  Future<void> addStream(Stream<List<int>> stream) async {}

  @override
  void add(List<int> data) {}

  @override
  Future<HttpClientResponse> close() async => _FakeResponse();

  @override
  Future<HttpClientResponse> get done async => _FakeResponse();

  // Returns null rather than deferring to super, which throws. The http client
  // calls close(force: true) and a handful of setters that this fake has no
  // opinion about, and every one of them was failing the test.
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeHeaders implements HttpHeaders {
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {}
  @override
  void forEach(void Function(String name, List<String> values) action) {}
  @override
  String? value(String name) => null;
  // Returns null rather than deferring to super, which throws. The http client
  // calls close(force: true) and a handful of setters that this fake has no
  // opinion about, and every one of them was failing the test.
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeResponse extends Stream<List<int>> implements HttpClientResponse {
  @override
  int get statusCode => 200;
  @override
  String get reasonPhrase => 'OK';
  @override
  bool get isRedirect => false;
  @override
  bool get persistentConnection => false;
  @override
  List<RedirectInfo> get redirects => const [];
  @override
  int get contentLength => 2;
  @override
  HttpHeaders get headers => _FakeHeaders();

  @override
  StreamSubscription<List<int>> listen(void Function(List<int>)? onData,
          {Function? onError, void Function()? onDone, bool? cancelOnError}) =>
      Stream<List<int>>.fromIterable([utf8.encode('[]')])
          .listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);

  // Returns null rather than deferring to super, which throws. The http client
  // calls close(force: true) and a handful of setters that this fake has no
  // opinion about, and every one of them was failing the test.
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

void main() {
  late _CountingHttpOverrides http;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await ApiService.init();
    http = _CountingHttpOverrides();
    HttpOverrides.global = http;
  });

  tearDown(() => HttpOverrides.global = null);

  // MemoryScreen is a tab body, not a page: it draws Material widgets and
  // expects the Scaffold its host in main.dart provides.
  Widget host({required bool isVisible}) =>
      MaterialApp(home: Scaffold(body: MemoryScreen(isVisible: isVisible)));

  Future<void> pumpScreen(WidgetTester tester, {required bool isVisible}) async {
    await tester.pumpWidget(host(isVisible: isVisible));
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets('the visible tab polls, once per interval', (tester) async {
    await pumpScreen(tester, isVisible: true);
    final afterLoad = http.memorySearchCalls;
    expect(afterLoad, greaterThanOrEqualTo(1), reason: 'the first load happens on mount');

    await tester.pump(const Duration(seconds: 15));
    expect(http.memorySearchCalls, afterLoad + 1, reason: 'one poll per interval');
    await tester.pump(const Duration(seconds: 15));
    await tester.pump(const Duration(seconds: 15));
    expect(http.memorySearchCalls, afterLoad + 3, reason: 'and no faster than that');
  });

  testWidgets('a tab the user is not looking at never polls', (tester) async {
    await pumpScreen(tester, isVisible: false);
    final afterLoad = http.memorySearchCalls;

    await tester.pump(const Duration(seconds: 15));
    await tester.pump(const Duration(seconds: 15));
    await tester.pump(const Duration(seconds: 60));
    expect(http.memorySearchCalls, afterLoad,
        reason: 'IndexedStack keeps it mounted, but it must stay quiet');
  });

  testWidgets('polling starts and stops as the tab is shown and hidden', (tester) async {
    await pumpScreen(tester, isVisible: false);
    final mounted = http.memorySearchCalls;

    // Shown.
    await tester.pumpWidget(host(isVisible: true));
    await tester.pump(const Duration(seconds: 15));
    expect(http.memorySearchCalls, greaterThan(mounted), reason: 'it polls once shown');

    // Hidden again.
    final whileVisible = http.memorySearchCalls;
    await tester.pumpWidget(host(isVisible: false));
    await tester.pump(const Duration(seconds: 60));
    expect(http.memorySearchCalls, whileVisible, reason: 'and stops once hidden');
  });

  testWidgets('a backgrounded app stops polling, and catches up on return',
      (tester) async {
    await pumpScreen(tester, isVisible: true);

    // The framework rejects a jump straight from paused back to resumed, so the
    // real sequence is walked in both directions. Anything other than resumed
    // counts as background, so the timer stops at the first step.
    Future<void> lifecycle(List<AppLifecycleState> states) async {
      for (final state in states) {
        tester.binding.handleAppLifecycleStateChanged(state);
        await tester.pump();
      }
    }

    await lifecycle([
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]);
    final whenPaused = http.memorySearchCalls;
    await tester.pump(const Duration(seconds: 60));
    expect(http.memorySearchCalls, whenPaused,
        reason: 'the phone is in a pocket; nothing should be fetched');

    // Coming back is exactly when the list is most likely stale, so it refreshes
    // at once rather than waiting out another interval.
    await lifecycle([
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]);
    await tester.pump(const Duration(milliseconds: 50));
    expect(http.memorySearchCalls, whenPaused + 1,
        reason: 'one immediate catch-up on resume');
    await tester.pump(const Duration(seconds: 15));
    expect(http.memorySearchCalls, whenPaused + 2, reason: 'and polling resumes');
  });

  testWidgets('a past day is never polled, because it cannot change',
      (tester) async {
    await pumpScreen(tester, isVisible: true);
    // "All days" and a chosen past day both leave _isToday false.
    await tester.tap(find.text('All days'));
    await tester.pump(const Duration(milliseconds: 50));
    final afterSwitch = http.memorySearchCalls;
    await tester.pump(const Duration(seconds: 60));
    expect(http.memorySearchCalls, afterSwitch,
        reason: 'a day in the past cannot gain new memories');
  });

  testWidgets('the timer does not outlive the screen', (tester) async {
    await pumpScreen(tester, isVisible: true);
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));
    final afterDispose = http.memorySearchCalls;
    await tester.pump(const Duration(seconds: 60));
    expect(http.memorySearchCalls, afterDispose,
        reason: 'a Timer outlives its State unless cancelled in dispose');
    // An uncancelled periodic timer also fails the test framework's own pending
    // timer check, so reaching here at all is part of the assertion.
  });

  testWidgets('a background poll shows no loading spinner', (tester) async {
    await pumpScreen(tester, isVisible: true);
    await tester.pump(const Duration(seconds: 15));
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byType(CircularProgressIndicator), findsNothing,
        reason: 'the list must not blink away under whoever is reading it');
  });
}
