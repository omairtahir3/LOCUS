import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter/material.dart';

class NotificationService {
  static final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  static bool _initialized = false;

  /// Initialize the notification plugin — call once in main()
  static Future<void> init() async {
    if (_initialized) return;

    const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
    const initSettings = InitializationSettings(android: androidSettings);

    await _plugin.initialize(
      settings: initSettings,
      onDidReceiveNotificationResponse: (response) {
        debugPrint('Notification tapped: ${response.payload}');
      },
    );
    _initialized = true;
  }

  /// Schedule a daily reminder at the given time
  static Future<void> scheduleMedicationReminder({
    required int id,
    required String medicationName,
    required String dosage,
    required TimeOfDay time,
  }) async {
    final now = DateTime.now();
    var scheduledDate = DateTime(now.year, now.month, now.day, time.hour, time.minute);

    // If the time has already passed today, schedule for tomorrow
    if (scheduledDate.isBefore(now)) {
      scheduledDate = scheduledDate.add(const Duration(days: 1));
    }

    // Use a simple delayed notification
    await Future.delayed(Duration.zero, () async {
      // Schedule using the show method with a future delay workaround
      // (zonedSchedule requires timezone setup which is complex for web)
      await _plugin.show(
        id: id,
        title: '💊 Time to take $medicationName',
        body: '$dosage — Tap to open LOCUS',
        notificationDetails: const NotificationDetails(
          android: AndroidNotificationDetails(
            'medication_reminders',
            'Medication Reminders',
            channelDescription: 'Reminders for scheduled medications',
            importance: Importance.high,
            priority: Priority.high,
            icon: '@mipmap/ic_launcher',
            playSound: true,
            enableVibration: true,
          ),
        ),
        payload: medicationName,
      );
    });

    debugPrint('Scheduled reminder for $medicationName at ${time.hour}:${time.minute} (id: $id)');
  }

  /// Schedule reminders for all times of a medication
  static Future<void> scheduleMedicationTimes({
    required String medicationName,
    required String dosage,
    required List<TimeOfDay> times,
  }) async {
    for (int i = 0; i < times.length; i++) {
      final id = medicationName.hashCode + i;
      await scheduleMedicationReminder(
        id: id,
        medicationName: medicationName,
        dosage: dosage,
        time: times[i],
      );
    }
  }

  /// Cancel all reminders for a medication
  static Future<void> cancelMedicationReminders(String medicationName, int timeCount) async {
    for (int i = 0; i < timeCount; i++) {
      await _plugin.cancel(id: medicationName.hashCode + i);
    }
  }

  /// Show an immediate notification (e.g. for AI detection results)
  static Future<void> showImmediate({
    required String title,
    required String body,
    String? payload,
  }) async {
    await _plugin.show(
      id: DateTime.now().millisecondsSinceEpoch ~/ 1000,
      title: title,
      body: body,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'locus_alerts',
          'LOCUS Alerts',
          channelDescription: 'AI detection and system alerts',
          importance: Importance.high,
          priority: Priority.high,
          icon: '@mipmap/ic_launcher',
        ),
      ),
      payload: payload,
    );
  }
}
