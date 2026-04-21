import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;

class ApiService {
  // Automatically switch between localhost for Web/iOS and 10.0.2.2 for Android emulator
  static String get baseUrl {
    if (kIsWeb) return 'http://localhost:8000/api';
    if (Platform.isAndroid) return 'http://10.0.2.2:8000/api';
    return 'http://localhost:8000/api';
  }

  static late SharedPreferences _prefs;
  static String? _token;
  static Map<String, dynamic>? _user;

  static Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    _token = _prefs.getString('locus_token');
    final userJson = _prefs.getString('locus_user');
    if (userJson != null) _user = jsonDecode(userJson);
  }

  static bool get isLoggedIn => _token != null;
  static String? get token => _token;
  static Map<String, dynamic>? get user => _user;
  static String get userRole => _user?['role'] ?? 'user';

  static Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    if (_token != null) 'Authorization': 'Bearer $_token',
  };

  // ── Auth ────────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> register(String name, String email, String password, String role) async {
    final res = await http.post(
      Uri.parse('$baseUrl/auth/register'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'name': name, 'email': email, 'password': password, 'role': role}),
    );
    final data = jsonDecode(res.body);
    if (res.statusCode == 201) {
      // After registration, log in to get a token
      final loginResult = await login(email, password);
      return loginResult;
    }
    return {'statusCode': res.statusCode, 'data': data};
  }

  static Future<Map<String, dynamic>> login(String email, String password) async {
    final res = await http.post(
      Uri.parse('$baseUrl/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    );
    final data = jsonDecode(res.body);
    if (res.statusCode == 200) {
      final token = data['access_token'];
      _token = token;
      // Fetch user profile from /me
      final meRes = await http.get(Uri.parse('$baseUrl/auth/me'), headers: _headers);
      final user = meRes.statusCode == 200 ? jsonDecode(meRes.body) : {'email': email};
      await _saveSession(token, user);
    }
    return {'statusCode': res.statusCode, 'data': data};
  }

  static Future<void> _saveSession(String token, Map<String, dynamic> user) async {
    _token = token;
    _user = user;
    await _prefs.setString('locus_token', token);
    await _prefs.setString('locus_user', jsonEncode(user));
  }

  static Future<void> clearToken() async {
    _token = null;
    _user = null;
    await _prefs.remove('locus_token');
    await _prefs.remove('locus_user');
  }

  // ── Medications (for own use or caregiver viewing) ──────────────────────

  static Future<List<dynamic>> getSchedule({String? userId}) async {
    final query = userId != null ? '?user_id=$userId' : '';
    final res = await http.get(Uri.parse('$baseUrl/medications/schedule/today$query'), headers: _headers);
    if (res.statusCode == 200) return jsonDecode(res.body) is List ? jsonDecode(res.body) : [];
    return [];
  }

  static Future<Map<String, dynamic>> getAdherenceSummary({String? userId}) async {
    final query = userId != null ? '?user_id=$userId' : '';
    final res = await http.get(Uri.parse('$baseUrl/medications/adherence/summary$query'), headers: _headers);
    if (res.statusCode == 200) return jsonDecode(res.body);
    return {};
  }

  static Future<List<dynamic>> getMedications({String? userId}) async {
    final query = userId != null ? '?user_id=$userId' : '';
    final res = await http.get(Uri.parse('$baseUrl/medications$query'), headers: _headers);
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : (data['medications'] ?? []);
    }
    return [];
  }

  static Future<List<dynamic>> getDoseHistory({String? userId, int limit = 20}) async {
    final query = userId != null ? '?user_id=$userId&limit=$limit' : '?limit=$limit';
    final res = await http.get(Uri.parse('$baseUrl/medications/logs/history$query'), headers: _headers);
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : (data['history'] ?? []);
    }
    return [];
  }

  static Future<Map<String, dynamic>> recordDose(String medicationId, String status, String scheduledTime, {String? notes}) async {
    final res = await http.post(
      Uri.parse('$baseUrl/medications/logs/'),
      headers: _headers,
      body: jsonEncode({
        'medication_id': medicationId, 
        'status': status, 
        'scheduled_time': scheduledTime,
        if (notes != null) 'notes': notes
      }),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> createMedication({
    required String name,
    required String dosage,
    required List<String> scheduledTimes,
    String frequency = 'daily',
    String? instructions,
    List<int>? daysOfWeek,
  }) async {
    final res = await http.post(
      Uri.parse('$baseUrl/medications'),
      headers: _headers,
      body: jsonEncode({
        'name': name,
        'dosage': dosage,
        'scheduled_times': scheduledTimes,
        'frequency': frequency,
        'start_date': DateTime.now().toIso8601String(),
        if (instructions != null) 'instructions': instructions,
        if (daysOfWeek != null) 'days_of_week': daysOfWeek,
      }),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> updateMedication({
    required String id,
    required String name,
    required String dosage,
    required List<String> scheduledTimes,
    String frequency = 'daily',
    String? instructions,
    List<int>? daysOfWeek,
  }) async {
    final res = await http.put(
      Uri.parse('$baseUrl/medications/$id'),
      headers: _headers,
      body: jsonEncode({
        'name': name,
        'dosage': dosage,
        'scheduled_times': scheduledTimes,
        'frequency': frequency,
        if (instructions != null) 'instructions': instructions,
        if (daysOfWeek != null) 'days_of_week': daysOfWeek,
      }),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> deleteMedication(String id) async {
    final res = await http.delete(
      Uri.parse('$baseUrl/medications/$id'),
      headers: _headers,
    );
    return {'statusCode': res.statusCode};
  }



  // ── Link caregiver (elderly user only) ──────────────────────────────────

  static Future<Map<String, dynamic>> linkCaregiver(String caregiverEmail) async {
    final res = await http.post(
      Uri.parse('$baseUrl/auth/link-caregiver'),
      headers: _headers,
      body: jsonEncode({'caregiver_email': caregiverEmail}),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  // ── Caregiver endpoints ─────────────────────────────────────────────────

  static Future<List<dynamic>> getMonitoredUsers() async {
    final res = await http.get(Uri.parse('$baseUrl/caregiver/users'), headers: _headers);
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }

  static Future<Map<String, dynamic>> getUserSummary(String userId) async {
    final res = await http.get(Uri.parse('$baseUrl/caregiver/users/$userId/summary'), headers: _headers);
    if (res.statusCode == 200) return jsonDecode(res.body);
    return {};
  }


  // ── Caregiver actions ────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> sendMessage(String userId, String title, String message) async {
    final res = await http.post(
      Uri.parse('$baseUrl/caregiver/users/$userId/message'),
      headers: _headers,
      body: jsonEncode({'title': title, 'message': message}),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> statusCheck(String userId) async {
    final res = await http.post(
      Uri.parse('$baseUrl/caregiver/users/$userId/status-check'),
      headers: _headers,
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<List<dynamic>> getVerificationEvents(String userId, {int limit = 10}) async {
    final res = await http.get(
      Uri.parse('$baseUrl/caregiver/users/$userId/verification-events?limit=$limit'),
      headers: _headers,
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }

  static Future<List<dynamic>> getAnomalies(String userId) async {
    final res = await http.get(
      Uri.parse('$baseUrl/caregiver/users/$userId/anomalies'),
      headers: _headers,
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }

  // ── Notifications ───────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> getNotificationsData({int limit = 50, bool unreadOnly = false}) async {
    final params = 'limit=$limit${unreadOnly ? '&unread_only=true' : ''}';
    final res = await http.get(Uri.parse('$baseUrl/notifications?$params'), headers: _headers);
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is Map<String, dynamic> ? data : {'notifications': [], 'unread_count': 0};
    }
    return {'notifications': [], 'unread_count': 0};
  }

  static Future<List<dynamic>> getNotifications({int limit = 20}) async {
    final data = await getNotificationsData(limit: limit);
    return data['notifications'] ?? [];
  }

  static Future<void> markNotificationRead(String id) async {
    await http.patch(Uri.parse('$baseUrl/notifications/$id/read'), headers: _headers);
  }

  static Future<void> markAllNotificationsRead() async {
    await http.patch(Uri.parse('$baseUrl/notifications/read-all'), headers: _headers);
  }

  static Future<void> acknowledgeNotification(String id) async {
    await http.patch(Uri.parse('$baseUrl/notifications/$id/acknowledge'), headers: _headers);
  }

  static Future<void> dismissNotification(String id) async {
    await http.delete(Uri.parse('$baseUrl/notifications/$id'), headers: _headers);
  }

  // ── AI Detection (proxied through Node.js backend) ─────────────────────

  static Future<Map<String, dynamic>> startDetection({
    String source = '0',
    String medicationId = 'test',
    String scheduledTime = '08:00',
  }) async {
    final res = await http.post(
      Uri.parse('$baseUrl/detection/start'),
      headers: _headers,
      body: jsonEncode({
        'source': source,
        'medication_id': medicationId,
        'scheduled_time': scheduledTime,
        'display': false,
      }),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> stopDetection() async {
    final res = await http.post(
      Uri.parse('$baseUrl/detection/stop'),
      headers: _headers,
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> getDetectionStatus() async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/detection/status'), headers: _headers);
      if (res.statusCode == 200) return jsonDecode(res.body);
    } catch (_) {}
    return {'is_running': false, 'buffer_size': 0};
  }

  static Future<List<dynamic>> getKeyframes({int limit = 50}) async {
    final res = await http.get(Uri.parse('$baseUrl/detection/keyframes?limit=$limit'), headers: _headers);
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }
}
