import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:pedometer/pedometer.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_service.dart';

/// Daily step count from the phone's hardware pedometer.
///
/// The sensor does NOT report "steps today". Android's STEP_COUNTER and iOS's
/// equivalent report steps since the device last rebooted, a number that only
/// ever grows and resets to zero on restart. Today's figure is therefore
/// (current reading - the reading at the first step of today), and both the
/// baseline and the day it belongs to have to be remembered across app
/// launches. That is what this service does.
///
/// Three cases it has to survive, all of which produce a reading LOWER than
/// the stored baseline:
///   * the device rebooted, so the counter restarted at zero
///   * the app was reinstalled and the baseline is gone
///   * a manufacturer's sensor misbehaved after a firmware update
/// In each the baseline is re-anchored to the current reading rather than
/// producing a negative count.
class StepService {
  static final StepService _instance = StepService._internal();
  factory StepService() => _instance;
  StepService._internal();

  static const _kBaseline = 'step_baseline_value';
  static const _kBaselineDate = 'step_baseline_date';
  static const _kTodaySteps = 'step_today_cached';

  StreamSubscription<StepCount>? _sub;
  int _todaySteps = 0;
  DateTime _lastSent = DateTime.fromMillisecondsSinceEpoch(0);

  /// Steps counted so far today, or null before the first sensor reading.
  int? get todaySteps => _sub == null && _todaySteps == 0 ? null : _todaySteps;

  /// The user's LOCAL day. Sending a UTC date would move everyone's step
  /// count across the midnight boundary by their offset from UTC.
  static String _localDay([DateTime? when]) {
    final d = when ?? DateTime.now();
    return '${d.year.toString().padLeft(4, '0')}-'
        '${d.month.toString().padLeft(2, '0')}-'
        '${d.day.toString().padLeft(2, '0')}';
  }

  /// Android 10+ requires ACTIVITY_RECOGNITION before the sensor will emit.
  /// Without it the stream simply never fires, with no error, so ask first.
  Future<bool> _ensurePermission() async {
    final status = await Permission.activityRecognition.status;
    if (status.isGranted) return true;
    if (status.isPermanentlyDenied) return false;
    return (await Permission.activityRecognition.request()).isGranted;
  }

  Future<void> start() async {
    if (_sub != null) return;
    if (!await _ensurePermission()) {
      debugPrint('[StepService] activity recognition denied; steps unavailable');
      return;
    }

    final prefs = await SharedPreferences.getInstance();
    _todaySteps = prefs.getInt(_kTodaySteps) ?? 0;

    _sub = Pedometer.stepCountStream.listen(
      (event) => _onReading(event.steps),
      onError: (e) => debugPrint('[StepService] pedometer error: $e'),
      cancelOnError: false,
    );
    debugPrint('[StepService] listening for steps');
  }

  Future<void> _onReading(int deviceTotal) async {
    final prefs = await SharedPreferences.getInstance();
    final today = _localDay();
    final storedDay = prefs.getString(_kBaselineDate);
    var baseline = prefs.getInt(_kBaseline);

    // New day, first ever reading, or the counter went backwards (reboot or
    // reinstall): anchor today's baseline to what the sensor says right now.
    if (storedDay != today || baseline == null || deviceTotal < baseline) {
      baseline = deviceTotal;
      await prefs.setInt(_kBaseline, baseline);
      await prefs.setString(_kBaselineDate, today);
      // A reboot mid-day loses the steps taken before it; keeping the count
      // we already had is closer to the truth than restarting at zero.
      if (storedDay != today) _todaySteps = 0;
    }

    final since = deviceTotal - baseline;
    if (since > _todaySteps) _todaySteps = since;
    await prefs.setInt(_kTodaySteps, _todaySteps);

    // The sensor fires on every step. Uploading that often would be absurd,
    // so send at most once a minute, and only when there is something to say.
    final now = DateTime.now();
    if (_todaySteps > 0 && now.difference(_lastSent).inSeconds >= 60) {
      _lastSent = now;
      unawaited(_upload(today, _todaySteps, deviceTotal));
    }
  }

  Future<void> _upload(String date, int steps, int deviceTotal) async {
    final token = ApiService.token;
    if (token == null) return;
    try {
      final res = await http.put(
        Uri.parse('${ApiService.baseUrl}/users/me/steps'),
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $token'},
        body: jsonEncode({'date': date, 'steps': steps, 'raw_device_total': deviceTotal}),
      );
      if (res.statusCode != 200) {
        debugPrint('[StepService] upload failed ${res.statusCode}: ${res.body}');
      }
    } catch (e) {
      // Offline is normal and not worth surfacing: the count keeps
      // accumulating locally and the next successful send carries it, because
      // the server takes the higher of the two values.
      debugPrint('[StepService] upload error: $e');
    }
  }

  /// Send whatever has been counted, regardless of the once-a-minute limit.
  Future<void> flush() async {
    if (_todaySteps > 0) {
      _lastSent = DateTime.now();
      await _upload(_localDay(), _todaySteps, 0);
    }
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
  }
}
