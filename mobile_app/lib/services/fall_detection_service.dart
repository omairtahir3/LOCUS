import 'dart:async';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:sensors_plus/sensors_plus.dart';
import 'package:locus_mobile/services/api_service.dart';

class FallDetectionService {
  static final FallDetectionService _instance = FallDetectionService._internal();
  factory FallDetectionService() => _instance;
  FallDetectionService._internal();

  StreamSubscription? _accelerometerSubscription;
  
  bool _isListening = false;
  bool _spikeDetected = false;
  DateTime? _spikeTime;
  Timer? _stillnessTimer;

  // Thresholds (using userAccelerometer, so gravity is removed)
  // Normal movement is typically < 10 m/s^2
  // A heavy impact/fall is often > 25 m/s^2
  static const double impactThreshold = 25.0; 
  // Stillness threshold (lying on the ground)
  static const double stillnessThreshold = 1.5; 
  // How long to wait after spike to confirm stillness (seconds)
  static const int stillnessDuration = 5;

  void startListening() {
    if (_isListening) return;
    
    debugPrint('[FallDetection] Starting service...');
    _isListening = true;
    _spikeDetected = false;
    
    _accelerometerSubscription = userAccelerometerEventStream().listen((UserAccelerometerEvent event) {
      double gForce = sqrt(event.x * event.x + event.y * event.y + event.z * event.z);
      
      if (!_spikeDetected) {
        if (gForce > impactThreshold) {
          debugPrint('[FallDetection] High impact detected: ${gForce.toStringAsFixed(2)} m/s²');
          _spikeDetected = true;
          _spikeTime = DateTime.now();
          
          // Start the stillness timer
          _stillnessTimer?.cancel();
          _stillnessTimer = Timer(const Duration(seconds: stillnessDuration), _checkStillness);
        }
      } else {
        // We are in the "checking for stillness" phase.
        // If they start moving heavily again before the timer ends, cancel the fall.
        // (If gForce > 5.0, they are clearly moving/getting up)
        if (gForce > 5.0) {
          debugPrint('[FallDetection] Movement detected after spike, cancelling fall alarm.');
          _resetDetection();
        }
      }
    });
  }

  void _checkStillness() {
    if (_spikeDetected && _spikeTime != null) {
      // If the timer completed without being cancelled by movement, we assume a fall.
      debugPrint('[FallDetection] FALL CONFIRMED. Triggering SOS.');
      _triggerSos();
    }
    _resetDetection();
  }

  void _resetDetection() {
    _spikeDetected = false;
    _spikeTime = null;
    _stillnessTimer?.cancel();
  }

  Future<void> _triggerSos() async {
    try {
      await ApiService.triggerEmergencySos();
      debugPrint('[FallDetection] SOS Webhook fired successfully.');
    } catch (e) {
      debugPrint('[FallDetection] Failed to trigger SOS: $e');
    }
  }

  void stopListening() {
    if (!_isListening) return;
    debugPrint('[FallDetection] Stopping service...');
    _accelerometerSubscription?.cancel();
    _resetDetection();
    _isListening = false;
  }
}
