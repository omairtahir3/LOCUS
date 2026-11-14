import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'api_service.dart';

class SocketService {
  static final SocketService _instance = SocketService._internal();
  factory SocketService() => _instance;
  SocketService._internal();

  IO.Socket? socket;

  // Multiple screens may be mounted at once (e.g. CaregiverHomeScreen underneath
  // a pushed LocationMapScreen), so each event fans out to a list of subscribers
  // instead of a single overwritable field. A screen adds its own listener in
  // initState and removes only that listener in dispose, leaving any other
  // still-mounted screen's subscription intact.
  final List<void Function(Map<String, dynamic>)> _sosAlertListeners = [];
  final List<void Function(Map<String, dynamic>)> _sosResolvedListeners = [];
  final List<void Function(Map<String, dynamic>)> _locationUpdateListeners = [];

  void addSosAlertListener(void Function(Map<String, dynamic>) listener) {
    _sosAlertListeners.add(listener);
  }

  void removeSosAlertListener(void Function(Map<String, dynamic>) listener) {
    _sosAlertListeners.remove(listener);
  }

  void addSosResolvedListener(void Function(Map<String, dynamic>) listener) {
    _sosResolvedListeners.add(listener);
  }

  void removeSosResolvedListener(void Function(Map<String, dynamic>) listener) {
    _sosResolvedListeners.remove(listener);
  }

  void addLocationUpdateListener(void Function(Map<String, dynamic>) listener) {
    _locationUpdateListeners.add(listener);
  }

  void removeLocationUpdateListener(void Function(Map<String, dynamic>) listener) {
    _locationUpdateListeners.remove(listener);
  }

  /// The token the live socket was built with, so a change of account can be
  /// noticed. Without it the socket keeps whoever it was first opened as.
  String? _authedAs;

  /// The address the live socket was built against.
  ///
  /// THIS IS WHY THE SOCKET WAS NEVER ESTABLISHED. The server's LAN address is
  /// a guess at startup and discoverServer() corrects it a few seconds later,
  /// in the background, by calling ApiService.setServerOverride(). Every HTTP
  /// call reads ApiService.baseUrl fresh, so the app recovers on its own and
  /// the screens fill in -- but the socket reads baseUrl ONCE, in init(), and
  /// init() returned early ever after because the token had not changed. So
  /// the socket stayed pointed at an address nothing answers on, for the whole
  /// life of the app, while every other part of it worked.
  ///
  /// That is the shape of the bug people kept reporting as "the data loads but
  /// chats and calls do nothing".
  String? _connectedTo;

  /// Where the socket should be: baseUrl without its /api path.
  static String _endpoint() {
    final uri = Uri.parse(ApiService.baseUrl);
    return '${uri.scheme}://${uri.host}:${uri.port}';
  }

  /// The server was found at a different address; move the socket to it.
  ///
  /// Called by ApiService when the address changes. Without this the socket
  /// only notices at the next init(), which in practice means never: init()
  /// runs in a home screen's initState, and by the time discovery corrects
  /// the address that screen is already built.
  void rebindIfMoved() {
    if (socket == null) return; // Nothing built yet; init() will use the new one.
    if (_connectedTo == _endpoint()) return;
    print('[Socket] Server moved: $_connectedTo -> ${_endpoint()}; reconnecting');
    init();
    socket?.connect();
  }

  /// Every handler anyone has registered, by event name.
  ///
  /// THIS IS WHY CALLS AND MESSAGES KEPT GOING MISSING. init() disposes the
  /// socket and builds a new one whenever the token changes, and it
  /// re-attached its OWN three handlers to the replacement -- but
  /// VoiceCallService had wired call:incoming, call:answered, call:ice and
  /// call:ended straight onto the old object, and ChatScreen had wired
  /// chat_message onto it too. Neither is told about the rebuild, so both went
  /// on listening to a dead socket while the server delivered to the live one.
  /// The symptom is a call that never rings and a message that never arrives,
  /// intermittently, with nothing in any log to say why.
  ///
  /// Registering here attaches a handler to whichever socket is current,
  /// including every socket built after it.
  final Map<String, List<void Function(dynamic)>> _handlers = {};

  /// Listen for [event], across socket rebuilds.
  void on(String event, void Function(dynamic) handler) {
    _handlers.putIfAbsent(event, () => []).add(handler);
    socket?.on(event, handler);
  }

  /// Stop listening. Safe when the socket has since been replaced.
  void off(String event, void Function(dynamic) handler) {
    _handlers[event]?.remove(handler);
    try {
      socket?.off(event, handler);
    } catch (_) {
      // The socket it was attached to has already gone.
    }
  }

  /// Send [data] on the current socket. A passthrough so a caller never has
  /// to hold the socket object itself -- holding it is what left the call
  /// handlers attached to a disposed one.
  void emit(String event, [dynamic data]) {
    socket?.emit(event, data);
  }

  /// Re-attach everything to a freshly built socket.
  void _rewire() {
    final s = socket;
    if (s == null) return;
    _handlers.forEach((event, list) {
      for (final h in list) {
        s.on(event, h);
      }
    });
  }

  /// When was the address last re-checked, so a failing socket cannot start a
  /// subnet scan on every retry. socket_io_client reconnects on its own
  /// schedule and would otherwise run one scan per attempt, forever.
  DateTime? _lastHeal;

  /// The socket cannot reach the server; find out whether it has moved.
  ///
  /// The address is discovered once, at startup. If the router hands the
  /// laptop a new lease afterwards -- which is the ordinary case on this
  /// network, and the reason discoverServer() exists at all -- nothing told
  /// the app, and the socket went on retrying an address with nothing behind
  /// it for as long as the app stayed open.
  ///
  /// ensureServerReachable() pings first and only scans if that fails, so the
  /// usual outcome is one cheap request. A success calls setServerOverride(),
  /// which calls rebindIfMoved() above, which reconnects us.
  void _healAddress() {
    final now = DateTime.now();
    if (_lastHeal != null && now.difference(_lastHeal!) < const Duration(seconds: 20)) {
      return;
    }
    _lastHeal = now;
    ApiService.ensureServerReachable();
  }

  void init() {
    // A socket built for a different account is worse than no socket: the app
    // acts as the new user while the server still has the old one attached to
    // this connection, and anything decided by identity -- who may call whom,
    // which room an alert lands in -- is decided about the wrong person.
    final socketUrl = _endpoint();
    if (socket != null &&
        (_authedAs != ApiService.token || _connectedTo != socketUrl)) {
      final stale = socket;
      socket = null;
      try {
        stale?.dispose();
      } catch (_) {
        // Already gone. The replacement below is what matters.
      }
    }
    if (socket != null) return;
    _authedAs = ApiService.token;
    _connectedTo = socketUrl;

    socket = IO.io(socketUrl, IO.OptionBuilder()
        .setTransports(['websocket'])
        .setAuth({'token': ApiService.token})
        .disableAutoConnect()
        .build());

    socket!.onConnect((_) {
      print('[Socket] Connected securely to $socketUrl');
    });

    // A connection that fails silently is why this took four rounds to find.
    // socket_io_client reports the reason here and nowhere else, and nothing
    // was listening, so a socket pointed at a dead address looked exactly like
    // a socket nobody had tried to open.
    socket!.onConnectError((e) {
      print('[Socket] Could not connect to $socketUrl: $e');
      _healAddress();
    });
    socket!.onError((e) {
      print('[Socket] Error on $socketUrl: $e');
    });

    socket!.on('sos_alert', (data) {
      print('[Socket] SOS Alert Received: $data');
      for (final listener in List<void Function(Map<String, dynamic>)>.of(_sosAlertListeners)) {
        listener(data);
      }
    });

    socket!.on('sos_resolved', (data) {
      print('[Socket] SOS Resolved Received: $data');
      for (final listener in List<void Function(Map<String, dynamic>)>.of(_sosResolvedListeners)) {
        listener(data);
      }
    });

    socket!.on('LOCATION_UPDATE', (data) {
      print('[Socket] LOCATION_UPDATE Received: $data');
      for (final listener in List<void Function(Map<String, dynamic>)>.of(_locationUpdateListeners)) {
        listener(data);
      }
    });

    socket!.onDisconnect((_) => print('[Socket] Disconnected'));

    // Anything registered through on() belongs to the app, not to one
    // socket, so it follows the rebuild.
    _rewire();
  }

  void connect() {
    // Always through init(), never only when the socket is missing. A socket
    // belonging to the PREVIOUS account is not null, so the old test skipped
    // the rebuild and reopened the connection under the wrong identity --
    // which is how a call came to be refused for someone who was not making
    // it. init() is idempotent and compares the token itself.
    init();
    socket?.connect();
  }

  /// Drop the connection AND the socket, so the next sign-in builds a fresh
  /// one with its own token rather than reconnecting as the previous account.
  void reset() {
    try {
      socket?.dispose();
    } catch (_) {}
    socket = null;
    _authedAs = null;
    _connectedTo = null;
  }

  void disconnect() {
    socket?.disconnect();
  }
}
