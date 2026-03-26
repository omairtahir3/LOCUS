import 'dart:async';
import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class DetectionScreen extends StatefulWidget {
  const DetectionScreen({super.key});

  @override
  State<DetectionScreen> createState() => _DetectionScreenState();
}

class _DetectionScreenState extends State<DetectionScreen> {
  bool _isRunning = false;
  int _bufferSize = 0;
  bool _loading = false;
  String? _error;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _fetchStatus();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _fetchStatus() async {
    final status = await ApiService.getDetectionStatus();
    if (mounted) {
      setState(() {
        _isRunning = status['is_running'] ?? false;
        _bufferSize = status['buffer_size'] ?? 0;
      });
      if (_isRunning && _pollTimer == null) {
        _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) => _fetchStatus());
      } else if (!_isRunning) {
        _pollTimer?.cancel();
        _pollTimer = null;
      }
    }
  }

  Future<void> _startPipeline() async {
    setState(() { _loading = true; _error = null; });
    try {
      await ApiService.startDetection();
      await Future.delayed(const Duration(seconds: 1));
      await _fetchStatus();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _stopPipeline() async {
    setState(() { _loading = true; _error = null; });
    try {
      await ApiService.stopDetection();
      setState(() { _isRunning = false; _bufferSize = 0; });
      _pollTimer?.cancel();
      _pollTimer = null;
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Status card
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: _isRunning
                    ? [AppColors.success, const Color(0xFF059669)]
                    : [AppColors.textMuted, const Color(0xFF6B7280)],
              ),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white.withAlpha(40),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(
                    _isRunning ? Icons.visibility : Icons.visibility_off,
                    color: Colors.white, size: 28,
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('AI Detection Pipeline', style: TextStyle(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 2),
                      Text(
                        _isRunning ? 'Actively Monitoring' : 'Pipeline Stopped',
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 18),
                      ),
                      if (_isRunning)
                        Text('Buffer: $_bufferSize frames', style: const TextStyle(color: Colors.white70, fontSize: 13)),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
                  child: Text(
                    _isRunning ? 'LIVE' : 'OFF',
                    style: TextStyle(
                      color: _isRunning ? AppColors.success : AppColors.textMuted,
                      fontWeight: FontWeight.w700,
                      fontSize: 13,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),

          // Stats
          Row(
            children: [
              _statCard('Buffer', '$_bufferSize', Icons.storage_outlined, AppColors.primary),
              const SizedBox(width: 12),
              _statCard('Status', _isRunning ? 'Active' : 'Idle', Icons.speed_outlined, _isRunning ? AppColors.success : AppColors.textMuted),
            ],
          ),
          const SizedBox(height: 20),

          // Error message
          if (_error != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                color: AppColors.danger.withAlpha(20),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.danger.withAlpha(50)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber, color: AppColors.danger, size: 18),
                  const SizedBox(width: 8),
                  Expanded(child: Text(_error!, style: const TextStyle(color: AppColors.danger, fontSize: 13))),
                ],
              ),
            ),

          // Controls
          SizedBox(
            width: double.infinity,
            child: _isRunning
                ? ElevatedButton.icon(
                    onPressed: _loading ? null : _stopPipeline,
                    icon: _loading
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.stop_circle_outlined),
                    label: Text(_loading ? 'Stopping...' : 'Stop Pipeline'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.danger,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  )
                : ElevatedButton.icon(
                    onPressed: _loading ? null : _startPipeline,
                    icon: _loading
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.play_arrow),
                    label: Text(_loading ? 'Starting...' : 'Start Pipeline'),
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
          ),
          const SizedBox(height: 24),

          // Info
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Icon(Icons.info_outline, size: 16, color: AppColors.primary),
                  const SizedBox(width: 8),
                  const Text('How it works', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                ]),
                const SizedBox(height: 8),
                Text(
                  '1. Start the pipeline to begin video analysis\n'
                  '2. The AI monitors for medication intake\n'
                  '3. 3-phase verification: Pill detection → Gesture tracking → Confirmation\n'
                  '4. Results are automatically logged to the dashboard',
                  style: TextStyle(fontSize: 12, color: AppColors.textSecondary, height: 1.6),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _statCard(String label, String value, IconData icon, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: color.withAlpha(25), borderRadius: BorderRadius.circular(10)),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(width: 12),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
                Text(label, style: TextStyle(fontSize: 11, color: AppColors.textSecondary)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
