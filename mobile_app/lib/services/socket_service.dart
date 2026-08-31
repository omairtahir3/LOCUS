import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:flutter/material.dart';
import 'api_service.dart';

class SocketService {
  static final SocketService _instance = SocketService._internal();
  factory SocketService() => _instance;
  SocketService._internal();

  IO.Socket? socket;
  Function(Map<String, dynamic>)? onSosAlert;
  Function(Map<String, dynamic>)? onSosResolved;
  Function(Map<String, dynamic>)? onLocationUpdate;

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
      if (onSosAlert != null) onSosAlert!(data);
    });

    socket!.on('sos_resolved', (data) {
      print('[Socket] SOS Resolved Received: $data');
      if (onSosResolved != null) onSosResolved!(data);
    });

    socket!.on('LOCATION_UPDATE', (data) {
      print('[Socket] LOCATION_UPDATE Received: $data');
      if (onLocationUpdate != null) onLocationUpdate!(data);
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
