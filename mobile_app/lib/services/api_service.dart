import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb, kReleaseMode;

class ApiService {
  // Automatically switch between localhost for Web/iOS and 10.0.2.2 for Android emulator
  // UPDATED: Uses laptop IP for local dev, and Production URL when deployed.
  static String get baseUrl {
    if (kReleaseMode) {
      // When you deploy the app, it will use this production URL instead of your laptop's IP.
      // You can override this at build time using: flutter build apk --dart-define=API_URL=https://your-aws-url.com/api
      return const String.fromEnvironment('API_URL', defaultValue: 'https://your-production-server.com/api');
    }
    
    // For local development: use localhost for Web/iOS, 10.0.2.2 for Android emulators, 
    // and the laptop's actual IP for physical Android devices via Wi-Fi/USB.
    if (kIsWeb) return 'http://localhost:5000/api';
    return 'http://192.168.1.13:5000/api';
  }

  static late SharedPreferences _prefs;
  static String? _token;
  static Map<String, dynamic>? _user;

  static Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    _token = _prefs.getString('locus_token');
    final userJson = _prefs.getString('locus_user');
    if (userJson != null) {
      final decoded = jsonDecode(userJson);
      // Unwrap nested 'user' key from legacy cached sessions
      if (decoded is Map && decoded['user'] is Map && decoded['_id'] == null) {
        _user = Map<String, dynamic>.from(decoded['user']);
        // Re-save in unwrapped format
        await _prefs.setString('locus_user', jsonEncode(_user));
      } else {
        _user = Map<String, dynamic>.from(decoded);
      }
    }
  }

  static bool get isLoggedIn => _token != null;
  static String? get token => _token;
  static Map<String, dynamic>? get user => _user;
  static String get userRole => _user?['role'] ?? _user?['user']?['role'] ?? 'user';

  static Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    if (_token != null) 'Authorization': 'Bearer $_token',
  };

  static Future<Map<String, dynamic>> put(String endpoint, Map<String, dynamic> body) async {
    final res = await http.put(
      Uri.parse('$baseUrl$endpoint'),
      headers: _headers,
      body: jsonEncode(body),
    );
    if (res.body.isEmpty) return {'statusCode': res.statusCode};
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

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
      final token = data['access_token'] ?? data['token'];
      _token = token;
      // Fetch user profile from /me — response is { user: { _id, name, email, role, ... } }
      final meRes = await http.get(Uri.parse('$baseUrl/auth/me'), headers: _headers);
      Map<String, dynamic> user;
      if (meRes.statusCode == 200) {
        final body = jsonDecode(meRes.body);
        // Unwrap nested 'user' key if present
        user = body['user'] is Map ? Map<String, dynamic>.from(body['user']) : Map<String, dynamic>.from(body);
      } else {
        user = {'email': email};
      }
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

  static Future<Map<String, dynamic>> googleLogin(String googleToken, {String role = 'caregiver', bool confirmRole = false}) async {
    final res = await http.post(
      Uri.parse('$baseUrl/auth/google'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'token': googleToken, 'role': role, 'confirmRole': confirmRole}),
    ).timeout(const Duration(seconds: 10));
    final data = jsonDecode(res.body);
    if (res.statusCode == 200 && data['requiresRole'] != true) {
      final token = data['access_token'] ?? data['token'];
      _token = token;
      final meRes = await http.get(Uri.parse('$baseUrl/auth/me'), headers: _headers);
      Map<String, dynamic> user;
      if (meRes.statusCode == 200) {
        final body = jsonDecode(meRes.body);
        user = body['user'] is Map ? Map<String, dynamic>.from(body['user']) : Map<String, dynamic>.from(body);
      } else {
        user = data['user'] is Map ? Map<String, dynamic>.from(data['user']) : {};
      }
      await _saveSession(token, user);
    }
    return {'statusCode': res.statusCode, 'data': data};
  }

  static Future<Map<String, dynamic>> forgotPassword(String email) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/auth/forgot-password'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email}),
      );
      final data = jsonDecode(res.body);
      return {'statusCode': res.statusCode, 'data': data};
    } catch (e) {
      return {'statusCode': 500, 'data': {'error': e.toString()}};
    }
  }

  static Future<Map<String, dynamic>> resetPassword({required String id, required String token, required String newPassword}) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/auth/reset-password'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'id': id, 'token': token, 'newPassword': newPassword}),
      );
      final data = jsonDecode(res.body);
      return {'statusCode': res.statusCode, 'data': data};
    } catch (e) {
      return {'statusCode': 500, 'data': {'error': e.toString()}};
    }
  }

  static Future<void> logout() async {
    _token = null;
    _user = null;
    await _prefs.remove('locus_token');
    await _prefs.remove('locus_user');
  }

  static Future<void> clearToken() async {
    _token = null;
    _user = null;
    await _prefs.remove('locus_token');
    await _prefs.remove('locus_user');
  }

  static Future<void> updatePreferences(Map<String, dynamic> prefs) async {
    if (_token == null) throw Exception('Not authenticated');
    final res = await http.put(
      Uri.parse('$baseUrl/auth/preferences'),
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer $_token'},
      body: jsonEncode(prefs),
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      _user?['notification_prefs'] = data['notification_prefs'];
      await _prefs.setString('locus_user', jsonEncode(_user));
    } else {
      throw Exception('Failed to update preferences');
    }
  }

  // ── Medications (for own use or caregiver viewing) ──────────────────────

  static Future<List<dynamic>> getSchedule({String? userId}) async {
    final query = userId != null ? '?userId=$userId' : '';
    final res = await http.get(Uri.parse('$baseUrl/medications/schedule/today$query'), headers: _headers);
    if (res.statusCode == 200) {
      final list = (jsonDecode(res.body) is List ? jsonDecode(res.body) as List : []).toList();
      list.sort((a, b) {
        final tA = (a is Map && a['scheduled_time'] != null) ? a['scheduled_time'].toString() : '00:00';
        final tB = (b is Map && b['scheduled_time'] != null) ? b['scheduled_time'].toString() : '00:00';
        return tA.compareTo(tB);
      });
      return list;
    }
    return [];
  }

  static Future<Map<String, dynamic>> getAdherenceSummary({String? userId}) async {
    final query = userId != null ? '?user_id=$userId' : '';
    final res = await http.get(Uri.parse('$baseUrl/medications/adherence/summary$query'), headers: _headers);
    if (res.statusCode == 200) return jsonDecode(res.body);
    return {};
  }

  static Future<List<dynamic>> getMedications({String? userId}) async {
    final query = userId != null ? '?userId=$userId' : '';
    final res = await http.get(Uri.parse('$baseUrl/medications$query'), headers: _headers);
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      final list = (data is List ? data : (data['medications'] ?? [])).toList();
      for (var med in list) {
        if (med is Map && med['scheduled_times'] is List) {
          (med['scheduled_times'] as List).sort((a, b) => a.toString().compareTo(b.toString()));
        }
      }
      list.sort((a, b) {
        final timesA = (a is Map && a['scheduled_times'] is List) ? a['scheduled_times'] as List : [];
        final timesB = (b is Map && b['scheduled_times'] is List) ? b['scheduled_times'] as List : [];
        final tA = timesA.isNotEmpty ? timesA.first.toString() : '99:99';
        final tB = timesB.isNotEmpty ? timesB.first.toString() : '99:99';
        final comp = tA.compareTo(tB);
        if (comp != 0) return comp;
        return ((a is Map ? a['name'] : '') ?? '').toString().compareTo(((b is Map ? b['name'] : '') ?? '').toString());
      });
      return list;
    }
    return [];
  }

  static Future<List<dynamic>> getDoseHistory({String? userId, int limit = 20}) async {
    final query = userId != null ? '?userId=$userId&limit=$limit' : '?limit=$limit';
    final res = await http.get(Uri.parse('$baseUrl/medications/logs/history$query'), headers: _headers);
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : (data['history'] ?? []);
    }
    return [];
  }

  // ── Emergency (SOS) ────────────────────────────────────────────────────────
  
  static Future<void> triggerEmergency(double lat, double lng) async {
    final res = await http.post(
      Uri.parse('$baseUrl/users/me/emergency'),
      headers: _headers,
      body: jsonEncode({'lat': lat, 'lng': lng})
    );
    if (res.statusCode != 200) {
      throw Exception('Failed to trigger emergency: ${res.body}');
    }
  }
  
  static Future<void> cancelEmergency() async {
    final res = await http.delete(
      Uri.parse('$baseUrl/users/me/emergency'),
      headers: _headers,
    );
    if (res.statusCode != 200) {
      throw Exception('Failed to cancel emergency: ${res.body}');
    }
  }


  static Future<Map<String, dynamic>> recordDose(String medicationId, String status, String scheduledTime, {String? notes}) async {
    final res = await http.post(
      Uri.parse('$baseUrl/medications/logs/'),
      headers: _headers,
      body: jsonEncode({
        'medication_id': medicationId, 
        'status': status, 
        'scheduled_time': scheduledTime,
        'verification_method': 'manual',
        if (notes != null) 'notes': notes
      }),
    );
    if (res.statusCode >= 400) {
      throw Exception(jsonDecode(res.body)['error'] ?? 'Failed to record dose');
    }
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> updateLog(String logId, String status, {String? notes}) async {
    final res = await http.patch(
      Uri.parse('$baseUrl/medications/logs/$logId'),
      headers: _headers,
      body: jsonEncode({
        'status': status,
        'verification_method': 'manual',
        if (notes != null) 'notes': notes
      }),
    );
    if (res.statusCode >= 400) {
      throw Exception(jsonDecode(res.body)['error'] ?? 'Failed to update log');
    }
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> snoozeLog(String logId, {int minutes = 10}) async {
    final res = await http.post(
      Uri.parse('$baseUrl/medications/logs/$logId/snooze'),
      headers: _headers,
      body: jsonEncode({'snooze_duration_minutes': minutes}),
    );
    if (res.statusCode >= 400) {
      throw Exception(jsonDecode(res.body)['error'] ?? 'Failed to snooze log');
    }
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

  static Future<List<dynamic>> getNotifications({int limit = 20, bool unreadOnly = false}) async {
    final data = await getNotificationsData(limit: limit, unreadOnly: unreadOnly);
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

  static Future<void> respondNotification(String id, String message) async {
    await http.post(
      Uri.parse('$baseUrl/notifications/$id/respond'),
      headers: _headers,
      body: jsonEncode({'message': message}),
    );
  }

  static Future<void> snoozeNotification(String id, {int minutes = 10}) async {
    await http.post(
      Uri.parse('$baseUrl/notifications/$id/snooze'),
      headers: _headers,
      body: jsonEncode({'snooze_duration_minutes': minutes}),
    );
  }

  // ── AI Detection (proxied through Node.js backend) ─────────────────────

  static Future<Map<String, dynamic>> startDetection({
    String source = '',
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

  static Future<List<dynamic>> getKeyframes({int limit = 50, String? userId}) async {
    final query = userId != null ? '&user_id=$userId' : '';
    final res = await http.get(
      Uri.parse('$baseUrl/detection/keyframes?limit=$limit$query'),
      headers: _headers,
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }

  static Future<List<dynamic>> getMedicationFrames({int limit = 50, String? userId}) async {
    final query = userId != null ? '&user_id=$userId' : '';
    final res = await http.get(
      Uri.parse('$baseUrl/detection/medication_frames?limit=$limit$query'),
      headers: _headers,
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }

  static String medicationFrameImageUrl(String frameId) => '$baseUrl/detection/medication_frames/$frameId/image';

  // ── Event Logs / Memory Search ──────────────────────────────────────────────

  static Future<List<dynamic>> getMemorySearchEvents({int limit = 50}) async {
    final res = await http.get(
      Uri.parse('$baseUrl/event-logs/memory-search?limit=$limit'),
      headers: _headers,
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }

  static Future<List<dynamic>> getEventLogKeyframes({int limit = 50, String type = ''}) async {
    final res = await http.get(
      Uri.parse('$baseUrl/event-logs/keyframes?limit=$limit&type=$type'),
      headers: _headers,
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      return data is List ? data : [];
    }
    return [];
  }

  static Future<bool> toggleEventFlag(String eventId, bool isFlagged) async {
    try {
      final res = await http.patch(
        Uri.parse('$baseUrl/event-logs/$eventId/flag'),
        headers: _headers,
        body: jsonEncode({'is_flagged': isFlagged}),
      );
      return res.statusCode == 200;
    } catch (e) {
      return false;
    }
  }

  // ── Relationships ────────────────────────────────────────────────────────────

  static Future<Map<String, dynamic>> confirmFace(
    String eventId, 
    String personName, 
    String relationshipType, {
    bool forceNew = false,
    String? mergeInto,
  }) async {
    final res = await http.post(
      Uri.parse('$baseUrl/relationships/confirm'),
      headers: _headers,
      body: jsonEncode({
        'eventId': eventId,
        'personName': personName,
        'relationshipType': relationshipType,
        'force_new': forceNew,
        if (mergeInto != null) 'merge_into': mergeInto,
      }),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> getAllRelationships() async {
    final res = await http.get(Uri.parse('$baseUrl/relationships'), headers: _headers);
    if (res.statusCode == 200) {
      return {'statusCode': 200, 'data': jsonDecode(res.body)};
    }
    return {'statusCode': res.statusCode, 'data': []};
  }

  static Future<Map<String, dynamic>> mergeRelationships({required String sourceId, required String targetId}) async {
    final res = await http.post(
      Uri.parse('$baseUrl/relationships/merge'),
      headers: _headers,
      body: jsonEncode({
        'sourceId': sourceId,
        'targetId': targetId,
      }),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> getInteractions(String id) async {
    final res = await http.get(Uri.parse('$baseUrl/relationships/$id/interactions'), headers: _headers);
    if (res.statusCode == 200) {
      return {'statusCode': 200, 'data': jsonDecode(res.body)};
    }
    return {'statusCode': res.statusCode, 'data': {}};
  }

  static Future<Map<String, dynamic>> dismissFace(String eventId) async {
    final res = await http.post(
      Uri.parse('$baseUrl/relationships/dismiss'),
      headers: _headers,
      body: jsonEncode({'eventId': eventId}),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<Map<String, dynamic>> acknowledgeAction(String eventId) async {
    final res = await http.post(
      Uri.parse('$baseUrl/relationships/acknowledge'),
      headers: _headers,
      body: jsonEncode({'eventId': eventId}),
    );
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  // ── Home Location & Chat ──────────────────────────────────────────────────

  static Future<Map<String, dynamic>> setHomeLocation(double lat, double lng, {String? address}) async {
    final res = await http.put(
      Uri.parse('$baseUrl/users/me/home_location'),
      headers: _headers,
      body: jsonEncode({
        'lat': lat,
        'lng': lng,
        if (address != null) 'address': address,
      }),
    );
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body);
      if (_user != null) {
        _user!['home_location'] = data['home_location'];
        await _prefs.setString('locus_user', jsonEncode(_user));
      }
      return {'statusCode': 200, 'data': data};
    }
    return {'statusCode': res.statusCode, 'data': jsonDecode(res.body)};
  }

  static Future<List<dynamic>> getChatHistory(String otherUserId) async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/users/chat/$otherUserId'), headers: _headers);
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        return data is List ? data : [];
      }
    } catch (_) {}
    return [];
  }
}
