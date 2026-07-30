import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:google_sign_in/google_sign_in.dart';
import '../../services/api_service.dart';
import '../../theme/app_theme.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _nameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  String _selectedRole = 'user';
  bool _loading = false;
  String? _error;

  final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: ['email', 'profile'],
    serverClientId: kIsWeb ? null : '244657783963-pgq6940j7ie9ethpto2v5t2470m86clq.apps.googleusercontent.com',
  );

  Future<void> _handleGoogleSignIn() async {
    setState(() { _loading = true; _error = null; });
    try {
      await _googleSignIn.signOut(); // Force account selection prompt
      final GoogleSignInAccount? account = await _googleSignIn.signIn();
      if (account != null) {
        final GoogleSignInAuthentication auth = await account.authentication;
        final String? idToken = auth.idToken;
        if (idToken != null) {
          final res = await ApiService.googleLogin(idToken, role: _selectedRole, confirmRole: false);
          if (res['statusCode'] == 200) {
            final data = res['data'];
            if (data['requiresRole'] == true) {
              if (mounted) _showGoogleRoleSelectionSheet(idToken, data['name'] ?? 'User', data['picture']);
              return;
            }
            if (mounted) Navigator.pushReplacementNamed(context, '/home');
            return;
          } else {
            setState(() => _error = res['data']?['error'] ?? 'Google authentication failed');
          }
        } else {
          setState(() => _error = kIsWeb ? 'Google ID Token is not supported via popup in Flutter Web. Please test Google Sign-In on an Android/iOS emulator or device.' : 'Failed to retrieve Google token');
        }
      }
    } catch (e) {
      if (e.toString().contains('popup_closed')) {
        setState(() => _error = 'Google Sign-In popup closed or blocked by origin policy (random web port). Please run on Android/iOS.');
      } else {
        setState(() => _error = 'Google Sign-In error: $e');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _showGoogleRoleSelectionSheet(String idToken, String name, String? picture) {
    String selectedRole = _selectedRole;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setModalState) => Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom + 24, left: 24, right: 24, top: 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(width: 40, height: 4, decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2))),
              const SizedBox(height: 20),
              if (picture != null && picture.isNotEmpty)
                ClipOval(
                  child: Image.network(
                    picture,
                    width: 70,
                    height: 70,
                    fit: BoxFit.cover,
                    errorBuilder: (context, error, stackTrace) => Container(
                      width: 70,
                      height: 70,
                      color: AppColors.primaryLight,
                      child: Icon(Icons.person, size: 35, color: AppColors.primary),
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              Text('Welcome, $name!', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              const SizedBox(height: 6),
              Text('Please select your role in LOCUS to finish registration:', style: TextStyle(color: AppColors.textSecondary, fontSize: 14), textAlign: TextAlign.center),
              const SizedBox(height: 20),
              _roleModalCard('caregiver', Icons.family_restroom, 'Be a Caregiver', 'Monitor family members & alerts', selectedRole == 'caregiver', () => setModalState(() => selectedRole = 'caregiver')),
              const SizedBox(height: 10),
              _roleModalCard('user', Icons.person_outline, 'Track Myself', 'Manage my own health & prescriptions', selectedRole == 'user', () => setModalState(() => selectedRole = 'user')),
              const SizedBox(height: 10),
              _roleModalCard('elderly', Icons.elderly, 'Elderly User', 'Simplified interface & family linking', selectedRole == 'elderly', () => setModalState(() => selectedRole = 'elderly')),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _loading ? null : () async {
                    Navigator.pop(ctx);
                    setState(() => _loading = true);
                    try {
                      final res = await ApiService.googleLogin(idToken, role: selectedRole, confirmRole: true);
                      if (res['statusCode'] == 200) {
                        if (mounted) Navigator.pushReplacementNamed(context, '/home');
                      } else {
                        setState(() => _error = res['data']?['error'] ?? 'Google registration failed');
                      }
                    } finally {
                      if (mounted) setState(() => _loading = false);
                    }
                  },
                  style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                  child: const Text('Confirm & Complete Registration', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _roleModalCard(String key, IconData icon, String title, String desc, bool isSelected, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: isSelected ? AppColors.primaryLight : Colors.white,
          border: Border.all(color: isSelected ? AppColors.primary : AppColors.border, width: isSelected ? 2 : 1),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: isSelected ? AppColors.primary.withOpacity(0.15) : Colors.grey[100],
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: isSelected ? AppColors.primary : AppColors.textSecondary, size: 24),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15, color: isSelected ? AppColors.primaryDark : AppColors.textPrimary)),
                  const SizedBox(height: 2),
                  Text(desc, style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                ],
              ),
            ),
            if (isSelected) Icon(Icons.check_circle, color: AppColors.primary, size: 22),
          ],
        ),
      ),
    );
  }

  final _roles = [
    {'key': 'user', 'label': 'Normal User', 'icon': Icons.person_outline, 'desc': 'Daily usage & medication tracking'},
    {'key': 'elderly', 'label': 'Elderly User', 'icon': Icons.elderly, 'desc': 'Link family caregivers'},
    {'key': 'caregiver', 'label': 'Family Member', 'icon': Icons.family_restroom, 'desc': 'Monitor your loved ones'},
  ];

  Future<void> _register() async {
    if (_nameCtrl.text.isEmpty || _emailCtrl.text.isEmpty || _passCtrl.text.isEmpty) {
      setState(() => _error = 'All fields are required');
      return;
    }
    setState(() { _loading = true; _error = null; });
    try {
      final res = await ApiService.register(_nameCtrl.text, _emailCtrl.text, _passCtrl.text, _selectedRole);
      if (res['statusCode'] == 201) {
        if (mounted) Navigator.pushReplacementNamed(context, '/home');
      } else {
        setState(() => _error = res['data']?['error'] ?? 'Registration failed');
      }
    } catch (e) {
      setState(() => _error = 'Connection error. Is the backend running?');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 20),
              Center(child: Image.asset('assets/images/logo.png', height: 60)),
              const SizedBox(height: 24),
              Text('Create Account', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.5), textAlign: TextAlign.center),
              const SizedBox(height: 8),
              Text('Choose your account type', style: TextStyle(color: AppColors.textSecondary, fontSize: 15), textAlign: TextAlign.center),
              const SizedBox(height: 24),

              // Role selector
              Text('I AM A', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.textMuted, letterSpacing: 1)),
              const SizedBox(height: 8),
              ...(_roles.map((r) => _roleOption(r))),

              const SizedBox(height: 20),

              if (_error != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(color: AppColors.danger.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
                  child: Text(_error!, style: TextStyle(color: AppColors.danger, fontSize: 13)),
                ),

              // Form fields
              _inputField('Full Name', _nameCtrl, Icons.person_outline, 'Jane Smith'),
              const SizedBox(height: 14),
              _inputField('Email', _emailCtrl, Icons.email_outlined, 'you@example.com', type: TextInputType.emailAddress),
              const SizedBox(height: 14),
              _inputField('Password', _passCtrl, Icons.lock_outline, 'Min. 6 characters', obscure: true),
              const SizedBox(height: 24),

              ElevatedButton(
                onPressed: _loading ? null : _register,
                style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                child: _loading
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Text('Create Account', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(child: Divider(color: AppColors.border)),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: Text('or sign up with', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                  ),
                  Expanded(child: Divider(color: AppColors.border)),
                ],
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _loading ? null : _handleGoogleSignIn,
                  icon: const Icon(Icons.g_mobiledata, size: 28, color: Colors.red),
                  label: const Text('Continue with Google', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Colors.black87)),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    side: const BorderSide(color: Colors.grey),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text('Already have an account? ', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                  GestureDetector(
                    onTap: () => Navigator.pushReplacementNamed(context, '/login'),
                    child: Text('Sign in', style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w600, fontSize: 13)),
                  ),
                ],
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }

  Widget _roleOption(Map<String, dynamic> role) {
    final isSelected = _selectedRole == role['key'];
    return GestureDetector(
      onTap: () => setState(() => _selectedRole = role['key'] as String),
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: isSelected ? AppColors.primaryLight : Colors.white,
          border: Border.all(color: isSelected ? AppColors.primary : AppColors.border, width: isSelected ? 2 : 1),
          borderRadius: BorderRadius.circular(18),
          boxShadow: isSelected ? [BoxShadow(color: AppColors.primary.withValues(alpha: 0.1), blurRadius: 10, offset: const Offset(0, 4))] : null,
        ),
        child: Row(
          children: [
            Icon(role['icon'] as IconData, size: 22, color: isSelected ? AppColors.primary : AppColors.textMuted),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(role['label'] as String, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14, color: isSelected ? AppColors.primaryDark : AppColors.textPrimary)),
                  Text(role['desc'] as String, style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
                ],
              ),
            ),
            if (isSelected) Icon(Icons.check_circle, color: AppColors.primary, size: 20),
          ],
        ),
      ),
    );
  }

  Widget _inputField(String label, TextEditingController ctrl, IconData icon, String hint, {bool obscure = false, TextInputType? type}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
        const SizedBox(height: 6),
        TextField(
          controller: ctrl,
          obscureText: obscure,
          keyboardType: type,
          onChanged: (_) => setState(() => _error = null),
          decoration: InputDecoration(prefixIcon: Icon(icon, size: 18), hintText: hint),
        ),
      ],
    );
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _emailCtrl.dispose();
    _passCtrl.dispose();
    super.dispose();
  }
}
