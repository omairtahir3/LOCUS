import 'dart:async';
import 'dart:convert';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'api_service.dart';

class LocationService {
  static final LocationService _instance = LocationService._internal();
  factory LocationService() => _instance;
  LocationService._internal();

  StreamSubscription<Position>? _positionStreamSubscription;

  Future<void> startTracking() async {
    bool serviceEnabled;
    LocationPermission permission;

    // Test if location services are enabled.
    serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      return Future.error('Location services are disabled.');
    }

    permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        return Future.error('Location permissions are denied');
      }
    }
    
    if (permission == LocationPermission.deniedForever) {
      return Future.error('Location permissions are permanently denied, we cannot request permissions.');
    } 

    const LocationSettings locationSettings = LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 50, // Only trigger if moved by 50 meters
    );

    // Cancel existing stream if any
    await stopTracking();

    // Initial position fetch
    try {
      final position = await Geolocator.getCurrentPosition();
      _sendLocationToBackend(position);
    } catch(e) {
      print("Error getting initial position: $e");
    }

    _positionStreamSubscription = Geolocator.getPositionStream(locationSettings: locationSettings).listen(
      (Position? position) {
        if (position != null) {
          _sendLocationToBackend(position);
        }
      },
      onError: (e) {
        print("Location Stream Error: $e");
      }
    );
  }

  Future<void> stopTracking() async {
    await _positionStreamSubscription?.cancel();
    _positionStreamSubscription = null;
  }

  Future<void> _sendLocationToBackend(Position position) async {
    try {
      final token = ApiService.token;
      if (token == null) return;

      final url = Uri.parse('${ApiService.baseUrl}/location');
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $token',
        },
        body: json.encode({
          'lat': position.latitude,
          'lng': position.longitude,
          'accuracy': position.accuracy,
          'speed': position.speed,
          'timestamp': position.timestamp.toIso8601String(),
        }),
      );

      if (response.statusCode == 200) {
        print("Location sent successfully: ${position.latitude}, ${position.longitude}");
      } else {
        print("Failed to send location: ${response.statusCode} - ${response.body}");
      }
    } catch (e) {
      print("Exception sending location: $e");
    }
  }
}
