import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:google_sign_in/google_sign_in.dart';
import '../../services/api_service.dart';
import '../../theme/app_theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  bool _loading = false;
  String? _error;

  final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: ['email', 'profile'],
    clientId: kIsWeb ? null : '454678423894-37c3svs59772gipj48k9qvfqbvfbas3u.apps.googleusercontent.com',
    serverClientId: kIsWeb ? null : '454678423894-37c3svs59772gipj48k9qvfqbvfbas3u.apps.googleusercontent.com',
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
          final res = await ApiService.googleLogin(idToken, role: 'caregiver', confirmRole: false);
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
    String selectedRole = 'caregiver';
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

  Future<void> _login() async {
    if (_emailCtrl.text.isEmpty || _passCtrl.text.isEmpty) {
      setState(() => _error = 'Please fill in all fields');
      return;
    }
    setState(() { _loading = true; _error = null; });
    try {
      final res = await ApiService.login(_emailCtrl.text, _passCtrl.text);
      if (res['statusCode'] == 200) {
        if (mounted) Navigator.pushReplacementNamed(context, '/home');
      } else {
        setState(() => _error = res['data']?['error'] ?? 'Invalid credentials');
      }
    } catch (e) {
      setState(() => _error = 'Connection error: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _showForgotPasswordDialog() {
    final forgotCtrl = TextEditingController(text: _emailCtrl.text);
    bool forgotLoading = false;
    String? forgotMsg;
    String? forgotErr;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModalState) {
            return Padding(
              padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom, left: 24, right: 24, top: 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Reset Password', style: Theme.of(ctx).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                      IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text('Enter your email address and we will send you a secure 15-minute password reset link.', style: TextStyle(color: AppColors.textSecondary, fontSize: 14)),
                  const SizedBox(height: 20),

                  if (forgotMsg != null)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(color: Colors.green.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10), border: Border.all(color: Colors.green)),
                      child: Row(
                        children: [
                          const Icon(Icons.check_circle_outline, color: Colors.green, size: 20),
                          const SizedBox(width: 8),
                          Expanded(child: Text(forgotMsg!, style: const TextStyle(color: Colors.green, fontSize: 13))),
                        ],
                      ),
                    ),

                  if (forgotErr != null)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(color: AppColors.danger.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
                      child: Text(forgotErr!, style: TextStyle(color: AppColors.danger, fontSize: 13)),
                    ),

                  TextField(
                    controller: forgotCtrl,
                    keyboardType: TextInputType.emailAddress,
                    onChanged: (_) => setModalState(() => forgotErr = null),
                    decoration: const InputDecoration(prefixIcon: Icon(Icons.email_outlined, size: 18), hintText: 'you@example.com'),
                  ),
                  const SizedBox(height: 20),

                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: forgotLoading
                          ? null
                          : () async {
                              if (forgotCtrl.text.isEmpty) {
                                setModalState(() => forgotErr = 'Please enter your email address');
                                return;
                              }
                              setModalState(() { forgotLoading = true; forgotErr = null; forgotMsg = null; });
                              final res = await ApiService.forgotPassword(forgotCtrl.text);
                              if (res['statusCode'] == 200) {
                                setModalState(() {
                                  forgotLoading = false;
                                  forgotMsg = res['data']?['message'] ?? 'Reset link sent! Please check your email inbox.';
                                });
                              } else {
                                setModalState(() {
                                  forgotLoading = false;
                                  forgotErr = res['data']?['error'] ?? 'Failed to send reset link.';
                                });
                              }
                            },
                      style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                      child: forgotLoading
                          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Text('Send Reset Link', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    ),
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Image.asset('assets/images/logo.png', height: 60),
                const SizedBox(height: 24),
                Text('Welcome back', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.5)),
                const SizedBox(height: 8),
                Text('Sign in to continue', style: TextStyle(color: AppColors.textSecondary, fontSize: 15)),
                const SizedBox(height: 32),

                if (_error != null)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    margin: const EdgeInsets.only(bottom: 16),
                    decoration: BoxDecoration(color: AppColors.danger.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
                    child: Text(_error!, style: TextStyle(color: AppColors.danger, fontSize: 13)),
                  ),

                TextField(
                  controller: _emailCtrl,
                  keyboardType: TextInputType.emailAddress,
                  onChanged: (_) => setState(() => _error = null),
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.email_outlined, size: 18), hintText: 'Email'),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _passCtrl,
                  obscureText: true,
                  onChanged: (_) => setState(() => _error = null),
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.lock_outline, size: 18), hintText: 'Password'),
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: GestureDetector(
                    onTap: _showForgotPasswordDialog,
                    child: Text('Forgot Password?', style: TextStyle(color: AppColors.primary, fontSize: 13, fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(height: 24),

                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _loading ? null : _login,
                    style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                    child: _loading
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('Sign In', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  ),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(child: Divider(color: AppColors.border)),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Text('or continue with', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
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
                    Text('Don\'t have an account? ', style: TextStyle(color: AppColors.textSecondary, fontSize: 13)),
                    GestureDetector(
                      onTap: () => Navigator.pushReplacementNamed(context, '/register'),
                      child: Text('Sign up', style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w600, fontSize: 13)),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _emailCtrl.dispose();
    _passCtrl.dispose();
    super.dispose();
  }
}
