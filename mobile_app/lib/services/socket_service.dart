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

  void init() {
    if (socket != null) return;

    // Parse base URL for socket (remove /api path)
    final uri = Uri.parse(ApiService.baseUrl);
    final socketUrl = '${uri.scheme}://${uri.host}:${uri.port}';

    socket = IO.io(socketUrl, IO.OptionBuilder()
        .setTransports(['websocket'])
        .setAuth({'token': ApiService.token})
        .disableAutoConnect()
        .build());

    socket!.onConnect((_) {
      print('[Socket] Connected securely');
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
  }

  void connect() {
    if (socket == null) init();
    socket?.connect();
  }

  void disconnect() {
    socket?.disconnect();
  }
}
