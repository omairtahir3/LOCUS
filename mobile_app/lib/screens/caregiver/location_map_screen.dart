import 'dart:async';
import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:provider/provider.dart';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../services/api_service.dart';
import '../../services/selected_user_service.dart';
import '../../services/socket_service.dart';
import '../chat/chat_screen.dart';

class LocationMapScreen extends StatefulWidget {
  final String? targetUserId;

  const LocationMapScreen({Key? key, this.targetUserId}) : super(key: key);

  @override
  _LocationMapScreenState createState() => _LocationMapScreenState();
}

class _LocationMapScreenState extends State<LocationMapScreen> {
  final Completer<GoogleMapController> _controller = Completer();
  LatLng? _currentPosition;
  bool _isLoading = true;
  String? _error;
  Timer? _refreshTimer;
  DateTime? _lastUpdated;
  Map<String, dynamic>? _sosData;
  
  void _onSelectedUserChanged() {
    _fetchLocation();
  }

  @override
  void initState() {
    super.initState();
    SelectedUserService().addListener(_onSelectedUserChanged);
    _fetchLocation();
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) => _fetchLocation());

    // Subscribe to socket
    final socket = SocketService();
    socket.addLocationUpdateListener(_handleLocationUpdate);
    socket.addSosAlertListener(_handleSosAlert);
    socket.addSosResolvedListener(_handleSosResolved);
  }

  void _handleLocationUpdate(Map<String, dynamic> data) {
    final selectedId = widget.targetUserId ?? SelectedUserService().selectedUser?['_id'];
    if (data['user_id'] == selectedId && mounted) {
      setState(() {
        _currentPosition = LatLng(data['lat'], data['lng']);
        _lastUpdated = data['timestamp'] != null ? DateTime.parse(data['timestamp']) : DateTime.now();
      });
      _controller.future.then((c) => c.animateCamera(CameraUpdate.newLatLng(_currentPosition!)));
    }
  }

  void _handleSosAlert(Map<String, dynamic> data) {
    final selectedId = widget.targetUserId ?? SelectedUserService().selectedUser?['_id'];
    if (data['user_id'] == selectedId && mounted) {
      setState(() {
        _sosData = data;
        _currentPosition = LatLng(data['location']['lat'], data['location']['lng']);
        _lastUpdated = DateTime.now();
      });
      _controller.future.then((c) => c.animateCamera(CameraUpdate.newLatLng(_currentPosition!)));
    }
  }

  void _handleSosResolved(Map<String, dynamic> data) {
    final selectedId = widget.targetUserId ?? SelectedUserService().selectedUser?['_id'];
    if (data['user_id'] == selectedId && mounted) {
      setState(() { _sosData = null; });
    }
  }

  @override
  void dispose() {
    SelectedUserService().removeListener(_onSelectedUserChanged);
    _refreshTimer?.cancel();
    final socket = SocketService();
    socket.removeLocationUpdateListener(_handleLocationUpdate);
    socket.removeSosAlertListener(_handleSosAlert);
    socket.removeSosResolvedListener(_handleSosResolved);
    super.dispose();
  }

  Future<void> _fetchLocation() async {
    try {
      final token = ApiService.token;
      if (token == null) {
        if (mounted) setState(() { _error = 'Not authenticated'; _isLoading = false; });
        return;
      }

      String endpoint = '${ApiService.baseUrl}/location/latest';
      
      final selectedId = widget.targetUserId ?? SelectedUserService().selectedUser?['_id'];
      if (selectedId != null) {
        endpoint += '?user_id=$selectedId';
      }

      final response = await http.get(
        Uri.parse(endpoint),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
      );

      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        final lat = data['lat'] as double;
        final lng = data['lng'] as double;
        
        setState(() {
          _currentPosition = LatLng(lat, lng);
          _lastUpdated = data['timestamp'] != null ? DateTime.parse(data['timestamp']) : null;
          _isLoading = false;
          _error = null;
        });

        // Optionally move camera
        final GoogleMapController controller = await _controller.future;
        controller.animateCamera(CameraUpdate.newCameraPosition(
          CameraPosition(target: LatLng(lat, lng), zoom: 15),
        ));

      } else if (response.statusCode == 404) {
        setState(() {
          _error = 'No location data found yet.';
          _isLoading = false;
        });
      } else {
        setState(() {
          _error = 'Failed to fetch location data.';
          _isLoading = false;
        });
      }
    } catch (e) {
      setState(() {
        _error = 'Network error: $e';
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Live Location'),
        actions: [
          AnimatedBuilder(
            animation: SelectedUserService(),
            builder: (context, child) {
              final service = SelectedUserService();
              if (service.monitoringUsers.isEmpty) return const SizedBox.shrink();
              
              return Padding(
                padding: const EdgeInsets.only(right: 8.0),
                child: DropdownButtonHideUnderline(
                  child: DropdownButton<String>(
                    value: service.selectedUser?['_id'],
                    icon: const Icon(Icons.arrow_drop_down, color: Colors.black54),
                    style: const TextStyle(color: Colors.black87, fontWeight: FontWeight.bold, fontSize: 13),
                    onChanged: (String? newValue) {
                      if (newValue != null) {
                        service.setSelectedUser(newValue);
                      }
                    },
                    items: service.monitoringUsers.map<DropdownMenuItem<String>>((dynamic u) {
                      return DropdownMenuItem<String>(
                        value: u['_id'],
                        child: Text(u['name'] ?? 'Unknown'),
                      );
                    }).toList(),
                  ),
                ),
              );
            },
          ),
        ],
      ),
      body: Column(
        children: [
          if (_sosData != null)
            Container(
              padding: const EdgeInsets.all(16),
              color: Colors.red,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.warning, color: Colors.white),
                      const SizedBox(width: 8),
                      Text(
                        'EMERGENCY SOS: ${_sosData!['user_name']}',
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  const Text('Location updated automatically.', style: TextStyle(color: Colors.white)),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      ElevatedButton(
                        style: ElevatedButton.styleFrom(backgroundColor: Colors.transparent, foregroundColor: Colors.white, side: const BorderSide(color: Colors.white)),
                        onPressed: () {
                          Navigator.push(context, MaterialPageRoute(builder: (_) => ChatScreen(
                            recipientId: _sosData!['user_id'],
                            recipientName: _sosData!['user_name'],
                            isEmergency: true,
                          )));
                        },
                        child: const Text('OPEN CHAT'),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ElevatedButton(
                          style: ElevatedButton.styleFrom(backgroundColor: Colors.white, foregroundColor: Colors.red),
                          onPressed: () async {
                            try {
                              await http.delete(
                                Uri.parse('${ApiService.baseUrl}/users/${_sosData!['user_id']}/emergency'),
                                headers: {
                                  'Content-Type': 'application/json',
                                  'Authorization': 'Bearer ${ApiService.token}',
                                },
                              );
                              if (mounted) setState(() { _sosData = null; });
                            } catch (e) {
                              print(e);
                            }
                          },
                          child: const Text('RESOLVE'),
                        ),
                      ),
                    ],
                  )
                ],
              ),
            ),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.location_off, size: 64, color: Colors.grey),
            const SizedBox(height: 16),
            Text(_error!, style: const TextStyle(color: Colors.red)),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: () {
                setState(() => _isLoading = true);
                _fetchLocation();
              },
              child: const Text('Retry'),
            )
          ],
        ),
      );
    }

    if (_currentPosition == null) {
      return const Center(child: Text('Location not available.'));
    }

    Set<Marker> markers = {
      Marker(
        markerId: const MarkerId('current_location'),
        position: _currentPosition!,
        infoWindow: InfoWindow(
          title: 'Current Location',
          snippet: _lastUpdated != null ? 'Last updated: ${_lastUpdated!.toLocal().toString().split('.')[0]}' : '',
        ),
      )
    };

    return Stack(
      children: [
        GoogleMap(
          mapType: MapType.normal,
          initialCameraPosition: CameraPosition(
            target: _currentPosition!,
            zoom: 15,
          ),
          markers: markers,
          onMapCreated: (GoogleMapController controller) {
            _controller.complete(controller);
          },
        ),
        if (_lastUpdated != null)
          Positioned(
            bottom: 16,
            left: 16,
            right: 16,
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(12.0),
                child: Row(
                  children: [
                    const Icon(Icons.access_time, color: Colors.teal),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Last updated: ${_lastUpdated!.toLocal().toString().split('.')[0]}',
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.refresh),
                      onPressed: () {
                        _fetchLocation();
                      },
                    )
                  ],
                ),
              ),
            ),
          )
      ],
    );
  }
}
