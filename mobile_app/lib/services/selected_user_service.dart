import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_service.dart';

class SelectedUserService extends ChangeNotifier {
  static final SelectedUserService _instance = SelectedUserService._internal();
  factory SelectedUserService() => _instance;
  SelectedUserService._internal();

  Map<String, dynamic>? _selectedUser;
  List<dynamic> _monitoringUsers = [];
  bool _isLoading = false;

  Map<String, dynamic>? get selectedUser => _selectedUser;
  List<dynamic> get monitoringUsers => _monitoringUsers;
  bool get isLoading => _isLoading;

  Future<void> initialize() async {
    _isLoading = true;
    notifyListeners();

    try {
      final user = ApiService.user;
      // Anyone who is not a caregiver has nobody to select, so any selection
      // in hand belongs to a previous session on this device.
      if (user == null || user['role'] != 'caregiver') {
        await clear();
      }
      if (user != null && user['role'] == 'caregiver') {
        final usersResponse = await ApiService.getMonitoredUsers();
        if (usersResponse.isNotEmpty) {
          _monitoringUsers = List.from(usersResponse);
          
          if (_monitoringUsers.isNotEmpty) {
            final prefs = await SharedPreferences.getInstance();
            final storedId = prefs.getString('locus_selected_user_id');
            
            final foundIndex = _monitoringUsers.indexWhere((u) => u['_id'] == storedId);
            if (foundIndex != -1) {
              _selectedUser = _monitoringUsers[foundIndex];
            } else {
              _selectedUser = _monitoringUsers[0];
              prefs.setString('locus_selected_user_id', _selectedUser!['_id']);
            }
          }
        }
      }
    } catch (e) {
      debugPrint('Error initializing SelectedUserService: $e');
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> setSelectedUser(String userId) async {
    final foundIndex = _monitoringUsers.indexWhere((u) => u['_id'] == userId);
    if (foundIndex != -1) {
      _selectedUser = _monitoringUsers[foundIndex];
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('locus_selected_user_id', userId);
      notifyListeners();
    }
  }

  /// Forget who was being looked at: the selection, the list, and the id on
  /// disk.
  ///
  /// The stored id was the half that mattered and the half this missed. This
  /// is a singleton and the id outlives the process, so a caregiver's choice
  /// of person was inherited by whoever signed in next on the same phone --
  /// which is how a normal user with no caregivers came to be shown another
  /// person's name on the Keyframe Audit, and to request their frames.
  Future<void> clear() async {
    _selectedUser = null;
    _monitoringUsers = [];
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove('locus_selected_user_id');
    } catch (_) {
      // Not worth failing a sign-out over. The in-memory selection is already
      // gone, and initialize() clears again for anyone who is not a caregiver.
    }
    notifyListeners();
  }
}
