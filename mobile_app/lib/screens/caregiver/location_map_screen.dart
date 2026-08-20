import 'dart:async';
import 'package:flutter/material.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:provider/provider.dart';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../services/api_service.dart';

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

  @override
  void initState() {
    super.initState();
    _fetchLocation();
    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) => _fetchLocation());
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _fetchLocation() async {
    try {
      final token = ApiService.token;
      if (token == null) {
        setState(() {
          _error = 'Not authenticated';
          _isLoading = false;
        });
        return;
      }

      String endpoint = '${ApiService.baseUrl}/location/latest';
      if (widget.targetUserId != null) {
        endpoint += '?user_id=${widget.targetUserId}';
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
      ),
      body: _buildBody(),
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
