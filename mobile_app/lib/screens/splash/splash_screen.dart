import 'package:flutter/material.dart';
import 'dart:async';
import '../../services/api_service.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _navigateToNext();
  }

  void _navigateToNext() async {
    // Wait for 3 seconds as requested
    await Future.delayed(const Duration(seconds: 3));
    
    if (mounted) {
      // Check auth status and navigate accordingly
      final nextRoute = ApiService.isLoggedIn ? '/home' : '/login';
      Navigator.pushReplacementNamed(context, nextRoute);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // Fade-in animation for the logo
            TweenAnimationBuilder<double>(
              tween: Tween<double>(begin: 0.0, end: 1.0),
              duration: const Duration(seconds: 1),
              builder: (context, value, child) {
                return Opacity(
                  opacity: value,
                  child: Transform.scale(
                    scale: 0.8 + (value * 0.2),
                    child: child,
                  ),
                );
              },
              child: Image.asset(
                'assets/images/logo.png',
                width: 180,
                fit: BoxFit.contain,
              ),
            ),
            const SizedBox(height: 40),
            // Minimalist loading indicator to match the clean aesthetic
            const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                valueColor: AlwaysStoppedAnimation<Color>(Color(0xFF0D9488)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
