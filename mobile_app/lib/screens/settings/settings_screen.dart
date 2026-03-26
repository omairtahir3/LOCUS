import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final user = ApiService.user;
    final name = user?['name'] ?? 'User';
    final email = user?['email'] ?? '';
    final role = ApiService.userRole;
    final isElderly = role == 'elderly';

    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Profile card
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
            child: Row(
              children: [
                CircleAvatar(radius: 28, backgroundColor: AppColors.primary, child: Text(name.substring(0, 1).toUpperCase(), style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700))),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(name, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                      Text(email, style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
                      const SizedBox(height: 4),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                        decoration: BoxDecoration(color: AppColors.primaryLight, borderRadius: BorderRadius.circular(20)),
                        child: Text(
                          role == 'caregiver' ? 'Family Member' : role == 'elderly' ? 'Elderly User' : 'Normal User',
                          style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: AppColors.primaryDark),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),

          // Link Caregiver — only for elderly users
          if (isElderly) ...[
            _LinkCaregiverSection(),
            const SizedBox(height: 20),
          ],

          // Notification preferences
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Icon(Icons.notifications_outlined, size: 18, color: AppColors.primary),
                  const SizedBox(width: 10),
                  const Text('Notifications', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                ]),
                const SizedBox(height: 16),
                _toggleRow('Push Notifications', 'Get push alerts', true),
                _toggleRow('Missed Dose Alerts', 'Alert when a dose is missed', true),
                _toggleRow('Emergency Alerts', 'Panic button notifications', true),
              ],
            ),
          ),
          const SizedBox(height: 20),

          // App info
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Icon(Icons.info_outline, size: 18, color: AppColors.primary),
                  const SizedBox(width: 10),
                  const Text('About', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                ]),
                const SizedBox(height: 12),
                _infoRow('Version', '1.0.0'),
                _infoRow('Author', 'LOCUS Team'),
              ],
            ),
          ),
          const SizedBox(height: 20),

          // Sign out
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: () async {
                await ApiService.clearToken();
                if (context.mounted) Navigator.pushReplacementNamed(context, '/login');
              },
              icon: const Icon(Icons.logout, color: AppColors.danger),
              label: const Text('Sign Out', style: TextStyle(color: AppColors.danger)),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                side: BorderSide(color: AppColors.danger.withValues(alpha: 0.3)),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
          const SizedBox(height: 40),
        ],
      ),
    );
  }

  Widget _toggleRow(String title, String desc, bool initial) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                Text(desc, style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
              ],
            ),
          ),
          Switch(value: initial, onChanged: (_) {}, activeTrackColor: AppColors.primary),
        ],
      ),
    );
  }

  Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(fontSize: 13, color: AppColors.textSecondary)),
          Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

// ── Link Caregiver Section (elderly only) ───────────────────────────────
class _LinkCaregiverSection extends StatefulWidget {
  @override
  State<_LinkCaregiverSection> createState() => _LinkCaregiverSectionState();
}

class _LinkCaregiverSectionState extends State<_LinkCaregiverSection> {
  final _emailCtrl = TextEditingController();
  bool _loading = false;
  String? _message;
  bool _success = false;

  Future<void> _link() async {
    if (_emailCtrl.text.isEmpty) return;
    setState(() { _loading = true; _message = null; });
    try {
      final res = await ApiService.linkCaregiver(_emailCtrl.text.trim());
      if (res['statusCode'] == 200) {
        setState(() { _success = true; _message = 'Caregiver linked successfully!'; });
        _emailCtrl.clear();
      } else {
        setState(() { _success = false; _message = res['data']?['error'] ?? 'Failed to link caregiver'; });
      }
    } catch (_) {
      setState(() { _success = false; _message = 'Connection error'; });
    } finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: AppColors.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: AppColors.border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(Icons.link, size: 18, color: AppColors.primary),
            const SizedBox(width: 10),
            const Text('Link a Caregiver', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
          ]),
          const SizedBox(height: 8),
          Text('Enter your family member\'s email to let them monitor your medication and activities.', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _emailCtrl,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(hintText: 'Caregiver\'s email', contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12)),
                ),
              ),
              const SizedBox(width: 10),
              ElevatedButton(
                onPressed: _loading ? null : _link,
                style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12)),
                child: _loading ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Text('Link'),
              ),
            ],
          ),
          if (_message != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: _success ? AppColors.success.withValues(alpha: 0.1) : AppColors.danger.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(_message!, style: TextStyle(fontSize: 12, color: _success ? AppColors.success : AppColors.danger)),
            ),
          ],
        ],
      ),
    );
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    super.dispose();
  }
}
