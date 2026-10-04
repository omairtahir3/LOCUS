import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../../theme/app_theme.dart';
import '../../services/api_service.dart';

class ItemEnrollScreen extends StatefulWidget {
  const ItemEnrollScreen({super.key});

  @override
  State<ItemEnrollScreen> createState() => _ItemEnrollScreenState();
}

class _ItemEnrollScreenState extends State<ItemEnrollScreen> {
  final _nameController = TextEditingController();
  final ImagePicker _picker = ImagePicker();
  final List<Uint8List> _imageBytesList = [];
  final List<String> _base64Frames = [];
  bool _isSubmitting = false;

  // Ten is a floor, not a suggestion. This screen used to cap at five and ask
  // for three, which is why the enrolled phone had four photographs. Those four
  // agreed with each other at only 0.699, and the matcher spent the rest of its
  // life filling that gap from its own sightings until it drifted off the
  // object entirely. A gallery this thin cannot tell one belonging from another
  // across a room.
  static const int minPhotos = 10;
  static const int maxPhotos = 15;

  final List<String> _angleSuggestions = [
    'Front / Main View',
    'Back (Logos/Camera)',
    'Side Profile / Edges',
    'Top / Angled View',
    'Distinctive Marks / Case',
    'Held in your hand',
    'Lying on a table',
    'Further away, across the room',
    'In dimmer light',
    'At an angle, partly turned',
    'Close up on a detail',
    'Against a different background',
    'Slightly covered or overlapping',
    'From below',
    'Any other angle',
  ];

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _takePhoto() async {
    if (_base64Frames.length >= maxPhotos) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Maximum $maxPhotos photos reached.')),
      );
      return;
    }

    try {
      final XFile? photo = await _picker.pickImage(
        source: ImageSource.camera,
        maxWidth: 320,
        maxHeight: 320,
        imageQuality: 60,
      );

      if (photo != null) {
        final bytes = await photo.readAsBytes();
        final b64 = base64Encode(bytes);
        setState(() {
          _imageBytesList.add(bytes);
          _base64Frames.add(b64);
        });
      }
    } catch (e) {
      debugPrint('Camera error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not open camera: $e')),
        );
      }
    }
  }

  Future<void> _pickFromGallery() async {
    if (_base64Frames.length >= maxPhotos) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Maximum $maxPhotos photos reached.')),
      );
      return;
    }

    try {
      final List<XFile> picked = await _picker.pickMultiImage(
        maxWidth: 320,
        maxHeight: 320,
        imageQuality: 60,
      );

      if (picked.isNotEmpty) {
        for (final file in picked) {
          if (_base64Frames.length >= maxPhotos) break;
          final bytes = await file.readAsBytes();
          final b64 = base64Encode(bytes);
          setState(() {
            _imageBytesList.add(bytes);
            _base64Frames.add(b64);
          });
        }
      }
    } catch (e) {
      debugPrint('Gallery error: $e');
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not open gallery: $e')),
        );
      }
    }
  }

  void _removePhoto(int index) {
    setState(() {
      _imageBytesList.removeAt(index);
      _base64Frames.removeAt(index);
    });
  }

  Future<void> _submitEnrollment() async {
    final itemName = _nameController.text.trim();
    if (itemName.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a custom name for this item.')),
      );
      return;
    }

    if (_base64Frames.length < minPhotos) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 4),
          content: Text(
            'At least $minPhotos photos are needed, from different angles, distances '
            'and lighting (you have ${_base64Frames.length}). Fewer than this and the '
            'item cannot be told apart from similar objects.',
          ),
        ),
      );
      return;
    }

    setState(() => _isSubmitting = true);

    try {
      final res = await ApiService.enrollUserItem(itemName, _base64Frames);
      if (res['statusCode'] == 201) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Successfully enrolled "$itemName"!'),
              backgroundColor: AppColors.success,
            ),
          );
          Navigator.pop(context, true);
        }
      } else {
        final errMsg = res['data']?['error'] ?? 'Enrollment failed';
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('Error: $errMsg'),
              backgroundColor: AppColors.danger,
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Network error: $e'),
            backgroundColor: AppColors.danger,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final count = _base64Frames.length;
    final isReady = count >= 3 && _nameController.text.trim().isNotEmpty;

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        title: const Text('Enroll New Item'),
        backgroundColor: Colors.transparent,
        elevation: 0,
      ),
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Instruction Banner
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColors.primaryLight.withOpacity(0.6),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: AppColors.primary.withOpacity(0.3)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(
                              color: AppColors.primary,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(Icons.center_focus_strong, color: Colors.white, size: 20),
                          ),
                          const SizedBox(width: 12),
                          const Expanded(
                            child: Text(
                              '3-5 Multi-Angle Photos Required',
                              style: TextStyle(
                                fontWeight: FontWeight.w700,
                                fontSize: 15,
                                color: AppColors.primaryDark,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Text(
                        'Take $minPhotos to $maxPhotos clear photos of your item: different angles, '
                        'different distances, and a couple in the light you actually live in. '
                        'For plain items like a phone, a wallet or a bowl, include the marks that make '
                        'yours yours: a case, a sticker, a logo, a camera bump. The more it sees here, '
                        'the less it has to guess later.',
                        style: TextStyle(
                          fontSize: 13,
                          color: AppColors.primaryDark.withOpacity(0.9),
                          height: 1.4,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),

                // Item Name Input
                const Text(
                  'Item Name',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: AppColors.textPrimary),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _nameController,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    hintText: 'e.g. Grandma\'s Pill Box, House Keys, Reading Glasses',
                    hintStyle: TextStyle(color: AppColors.textMuted, fontSize: 14),
                    filled: true,
                    fillColor: AppColors.surface,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: AppColors.border),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: AppColors.border),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(16),
                      borderSide: const BorderSide(color: AppColors.primary, width: 2),
                    ),
                  ),
                ),
                const SizedBox(height: 24),

                // Angle progress & thumbnails
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'Angle Photos',
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: AppColors.textPrimary),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: count >= 3 ? AppColors.successLight : AppColors.warningLight,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        '$count / $maxPhotos photos ${count >= minPhotos ? '✓' : '(need $minPhotos)'}',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: count >= 3 ? AppColors.success : AppColors.warning,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),

                // Photo Grid / Angle Preview
                if (_imageBytesList.isEmpty)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(vertical: 36, horizontal: 20),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: AppColors.border, style: BorderStyle.solid),
                    ),
                    child: Column(
                      children: [
                        Icon(Icons.camera_alt_outlined, size: 48, color: AppColors.textMuted),
                        const SizedBox(height: 12),
                        const Text(
                          'No photos added yet',
                          style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15, color: AppColors.textPrimary),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'Tap below to take photos from multiple angles',
                          style: TextStyle(fontSize: 13, color: AppColors.textSecondary),
                        ),
                      ],
                    ),
                  )
                else
                  GridView.builder(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 3,
                      crossAxisSpacing: 10,
                      mainAxisSpacing: 10,
                      childAspectRatio: 1.0,
                    ),
                    itemCount: _imageBytesList.length,
                    itemBuilder: (context, index) {
                      final label = index < _angleSuggestions.length ? _angleSuggestions[index] : 'Angle ${index + 1}';
                      return Stack(
                        fit: StackFit.expand,
                        children: [
                          ClipRRect(
                            borderRadius: BorderRadius.circular(16),
                            child: Image.memory(
                              _imageBytesList[index],
                              fit: BoxFit.cover,
                            ),
                          ),
                          // Angle tag
                          Positioned(
                            bottom: 0,
                            left: 0,
                            right: 0,
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 4),
                              decoration: BoxDecoration(
                                color: Colors.black.withOpacity(0.65),
                                borderRadius: const BorderRadius.vertical(bottom: Radius.circular(16)),
                              ),
                              child: Text(
                                label,
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ),
                          // Remove button
                          Positioned(
                            top: 4,
                            right: 4,
                            child: GestureDetector(
                              onTap: () => _removePhoto(index),
                              child: Container(
                                padding: const EdgeInsets.all(4),
                                decoration: const BoxDecoration(
                                  color: Colors.black54,
                                  shape: BoxShape.circle,
                                ),
                                child: const Icon(Icons.close, size: 14, color: Colors.white),
                              ),
                            ),
                          ),
                        ],
                      );
                    },
                  ),
                const SizedBox(height: 16),

                // Capture buttons
                if (count < 5)
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _takePhoto,
                          icon: const Icon(Icons.camera_alt, size: 18),
                          label: const Text('Take Photo'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.primary,
                            side: const BorderSide(color: AppColors.primary),
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _pickFromGallery,
                          icon: const Icon(Icons.photo_library_outlined, size: 18),
                          label: const Text('From Gallery'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.accent,
                            side: const BorderSide(color: AppColors.accent),
                            padding: const EdgeInsets.symmetric(vertical: 14),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                          ),
                        ),
                      ),
                    ],
                  ),
                const SizedBox(height: 32),

                // Submit button
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    onPressed: isReady && !_isSubmitting ? _submitEnrollment : null,
                    icon: const Icon(Icons.cloud_upload_outlined, color: Colors.white),
                    label: Text(
                      _isSubmitting ? 'Extracting Embeddings...' : 'Extract & Enroll Item',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16, color: Colors.white),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      disabledBackgroundColor: AppColors.border,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                      elevation: 0,
                    ),
                  ),
                ),
                const SizedBox(height: 40),
              ],
            ),
          ),

          // Loading overlay
          if (_isSubmitting)
            Container(
              color: Colors.black45,
              child: Center(
                child: Container(
                  padding: const EdgeInsets.all(28),
                  margin: const EdgeInsets.symmetric(horizontal: 40),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(24),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const CircularProgressIndicator(color: AppColors.primary),
                      const SizedBox(height: 20),
                      const Text(
                        'Processing Embeddings',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Extracting 576-D MobileNetV3 visual features from your item photos...',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
