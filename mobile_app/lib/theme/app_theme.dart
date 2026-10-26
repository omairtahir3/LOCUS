import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppColors {
  static const primary = Color(0xFF0D9488);
  static const primaryLight = Color(0xFFCCFBF1);
  static const primaryDark = Color(0xFF0F766E);
  static const accent = Color(0xFF6366F1);
  static const accentLight = Color(0xFFEEF2FF);
  static const success = Color(0xFF10B981);
  static const successLight = Color(0xFFD1FAE5);
  static const warning = Color(0xFFF59E0B);
  static const warningLight = Color(0xFFFEF3C7);
  static const danger = Color(0xFFEF4444);
  static const dangerLight = Color(0xFFFEE2E2);
  static const info = Color(0xFF3B82F6);
  static const infoLight = Color(0xFFDBEAFE);
  static const background = Color(0xFFF8FAFC);
  static const surface = Colors.white;
  static const border = Color(0xFFE2E8F0);
  static const borderLight = Color(0xFFF1F5F9);
  static const textPrimary = Color(0xFF1E293B);
  static const textSecondary = Color(0xFF64748B);
  static const textMuted = Color(0xFF94A3B8);
}

class AppTheme {
  static ThemeData get lightTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: ColorScheme.light(
        primary: AppColors.primary,
        secondary: AppColors.accent,
        surface: AppColors.surface,
        error: AppColors.danger,
      ),
      scaffoldBackgroundColor: AppColors.background,
      textTheme: GoogleFonts.outfitTextTheme().apply(
        bodyColor: AppColors.textPrimary,
        displayColor: AppColors.textPrimary,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: AppColors.surface,
        foregroundColor: AppColors.textPrimary,
        elevation: 0,
        scrolledUnderElevation: 1,
        titleTextStyle: GoogleFonts.outfit(
          fontSize: 20,
          fontWeight: FontWeight.w800,
          color: AppColors.textPrimary,
          letterSpacing: -0.02,
        ),
      ),
      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(24),
          side: const BorderSide(color: AppColors.border, width: 1),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: Colors.white,
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          textStyle: GoogleFonts.outfit(fontWeight: FontWeight.w700, fontSize: 16),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.textPrimary,
          side: const BorderSide(color: AppColors.border),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          textStyle: GoogleFonts.outfit(fontWeight: FontWeight.w700, fontSize: 16),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
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
        hintStyle: GoogleFonts.outfit(color: AppColors.textMuted),
        labelStyle: GoogleFonts.outfit(color: AppColors.textSecondary, fontWeight: FontWeight.w600),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: Colors.white,
        selectedItemColor: AppColors.primary,
        unselectedItemColor: AppColors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
      ),
      dividerTheme: const DividerThemeData(color: AppColors.borderLight, thickness: 1),
      chipTheme: ChipThemeData(
        showCheckmark: false,
        backgroundColor: AppColors.borderLight,
        labelStyle: GoogleFonts.outfit(fontSize: 12, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        side: BorderSide.none,
      ),
    );
  }

  static ThemeData get locusLight => _locus(LocusPalette.light);

  static ThemeData _locus(LocusPalette p) {
    final body = GoogleFonts.plusJakartaSansTextTheme();
    TextStyle? display(TextStyle? s) =>
        GoogleFonts.bricolageGrotesque(textStyle: s, fontWeight: FontWeight.w700);
    final text = body
        .copyWith(
          displayLarge: display(body.displayLarge),
          displayMedium: display(body.displayMedium),
          displaySmall: display(body.displaySmall),
          headlineLarge: display(body.headlineLarge),
          headlineMedium: display(body.headlineMedium),
          headlineSmall: display(body.headlineSmall),
          titleLarge: display(body.titleLarge),
        )
        .apply(bodyColor: p.text, displayColor: p.text);
    final shape = RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(LocusTokens.radiusMd));
    const tap = Size(LocusTokens.tap, LocusTokens.tap);

    return ThemeData(
      useMaterial3: true,
      brightness: p.brightness,
      colorScheme: ColorScheme(
        brightness: p.brightness,
        primary: p.accent,
        onPrimary: p.onAccent,
        secondary: p.accentText,
        onSecondary: p.surface,
        error: p.status.danger,
        onError: p.surface,
        surface: p.surface,
        onSurface: p.text,
        onSurfaceVariant: p.text2,
        surfaceContainerHighest: p.surface2,
        outline: p.border,
      ),
      scaffoldBackgroundColor: p.bg,
      textTheme: text,
      appBarTheme: AppBarTheme(
        backgroundColor: p.bg,
        foregroundColor: p.text,
        elevation: 0,
        scrolledUnderElevation: 1,
        titleTextStyle: text.titleLarge,
      ),
      cardTheme: CardThemeData(
        color: p.surface,
        elevation: 1,
        shadowColor: p.shadow,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(LocusTokens.radiusLg)),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: p.accent,
          foregroundColor: p.onAccent,
          elevation: 0,
          minimumSize: tap,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: shape,
          textStyle: text.labelLarge?.copyWith(fontWeight: FontWeight.w700),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: p.text,
          side: BorderSide(color: p.border),
          minimumSize: tap,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: shape,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: p.accentText, minimumSize: tap),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.surface,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(LocusTokens.radiusMd),
          borderSide: BorderSide(color: p.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(LocusTokens.radiusMd),
          borderSide: BorderSide(color: p.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(LocusTokens.radiusMd),
          borderSide: BorderSide(color: p.accentText, width: 2),
        ),
        hintStyle: TextStyle(color: p.textMuted),
        labelStyle: TextStyle(color: p.text2),
      ),
      dividerTheme: DividerThemeData(color: p.border, thickness: 1),
      chipTheme: ChipThemeData(
        showCheckmark: false,
        backgroundColor: p.surface2,
        labelStyle: text.labelMedium,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(LocusTokens.radiusPill)),
        side: BorderSide.none,
      ),
    );
  }
}

/// Spacing, radii, touch target and motion; same numbers as src/tokens.css.
class LocusTokens {
  static const space1 = 4.0, space2 = 8.0, space3 = 12.0, space4 = 16.0;
  static const space5 = 24.0, space6 = 32.0, space7 = 48.0, space8 = 72.0;
  static const radiusSm = 10.0, radiusMd = 16.0, radiusLg = 24.0, radiusPill = 999.0;
  static const tap = 48.0;
  static const durFast = Duration(milliseconds: 140);
  static const durBase = Duration(milliseconds: 220);
  static const durSlow = Duration(milliseconds: 420);
  static const easeOut = Cubic(0.22, 1, 0.36, 1);

  /// [d], or zero when the system asks for reduced animations.
  static Duration motion(BuildContext context, Duration d) =>
      MediaQuery.of(context).disableAnimations ? Duration.zero : d;
}

/// Status colours: always shown with an icon and a word, never alone.
class LocusStatus {
  final Color taken, takenBg, verify, verifyBg, missed, missedBg;
  final Color cameraOff, cameraOffBg, danger, dangerBg;
  const LocusStatus({
    required this.taken, required this.takenBg,
    required this.verify, required this.verifyBg,
    required this.missed, required this.missedBg,
    required this.cameraOff, required this.cameraOffBg,
    required this.danger, required this.dangerBg,
  });

  // Light theme only, so there is one set.
  static LocusStatus of(BuildContext context) => LocusPalette.light.status;
}

/// The palette (light theme only); values match src/tokens.css, each text pair
/// checked at >= 4.5:1. Amber [accent] is a fill only; text uses [accentText].
class LocusPalette {
  final Brightness brightness;
  final Color bg, surface, surface2, border, text, text2, textMuted;
  final Color accent, onAccent, accentText, shadow;
  final LocusStatus status;
  const LocusPalette({
    required this.brightness,
    required this.bg, required this.surface, required this.surface2,
    required this.border, required this.text, required this.text2,
    required this.textMuted, required this.accent, required this.onAccent,
    required this.accentText, required this.shadow, required this.status,
  });


  static const light = LocusPalette(
    brightness: Brightness.light,
    bg: Color(0xFFF7F3EC), surface: Color(0xFFFFFDF9), surface2: Color(0xFFEFE8DC),
    border: Color(0xFFE1D8C9), text: Color(0xFF1C1A17), text2: Color(0xFF544E46),
    textMuted: Color(0xFF6B645A), accent: Color(0xFFE9A23B),
    onAccent: Color(0xFF1C1A17), accentText: Color(0xFF8A5508),
    shadow: Color(0x1F3C280F),
    status: LocusStatus(
      taken: Color(0xFF23704A), takenBg: Color(0xFFE3F1E8),
      verify: Color(0xFF2A5F94), verifyBg: Color(0xFFE3ECF6),
      missed: Color(0xFF8A3874), missedBg: Color(0xFFF4E4EF),
      cameraOff: Color(0xFF535C68), cameraOffBg: Color(0xFFE8EAEE),
      danger: Color(0xFFB42318), dangerBg: Color(0xFFFBE5E1),
    ),
  );

}
