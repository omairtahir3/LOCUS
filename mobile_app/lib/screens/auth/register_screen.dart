import 'package:flutter/material.dart';
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
              Center(child: Image.asset('assets/images/logo.png', height: 48)),
              const SizedBox(height: 12),
              Text('Create Account', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700), textAlign: TextAlign.center),
              const SizedBox(height: 4),
              Text('Choose your account type', style: TextStyle(color: AppColors.textSecondary, fontSize: 14), textAlign: TextAlign.center),
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
          color: isSelected ? AppColors.primaryLight : AppColors.surface,
          border: Border.all(color: isSelected ? AppColors.primary : AppColors.border, width: isSelected ? 2 : 1),
          borderRadius: BorderRadius.circular(12),
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
