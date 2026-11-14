import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// The LOCUS palette. The same values as web_app/frontend/src/tokens.css, so
/// the phone and the website are one design system rather than two that
/// happen to both be teal. Every text/background pair below was measured.
///
/// Teal [primary] carries actions. Amber [accent] is a FILL only -- it
/// measures 2.1:1 on [surface], so words in that hue use [accentText].
/// The dashboard palette, from web_app/frontend/src/index.css.
///
/// index.css is what styles every signed-in page on the web, and its :root is
/// the source for all of this. tokens.css (cream ground, amber accent) is the
/// LANDING page's system -- var(--lc-*) is read only by Landing.css, Auth.css
/// and Background.css -- so it is the wrong palette to match here.
///
/// The ink and the semantic text colours below are not the obvious ones: the
/// comments in index.css record why, and they are measured, so they are kept
/// verbatim rather than rounded to something tidier.
class AppColors {
  // Primary: teal. --primary is the FILL; --primary-dark is the pressed and
  // the on-tint ink.
  static const primary = Color(0xFF0D9488);
  static const primaryLight = Color(0xFFCCFBF1);
  static const primaryDark = Color(0xFF0F766E);
  static const onPrimary = Color(0xFFFFFFFF);

  // Accent: indigo.
  static const accent = Color(0xFF6366F1);
  static const accentLight = Color(0xFFEEF2FF);

  // Semantic FILLS -- marks, icons, bars. Measured on the ground these are
  // 2.42:1 (success), 2.05:1 (warning) and 3.60:1 (danger), so none of them
  // is legible as a label.
  static const success = Color(0xFF10B981);
  static const successLight = Color(0xFFD1FAE5);
  static const warning = Color(0xFFF59E0B);
  static const warningLight = Color(0xFFFEF3C7);
  static const danger = Color(0xFFEF4444);
  static const dangerLight = Color(0xFFFEE2E2);
  static const info = Color(0xFF3B82F6);
  static const infoLight = Color(0xFFDBEAFE);

  // The same meanings as WORDS. Each clears 4.6:1 on the ground. Use these
  // whenever the colour is carrying text, and the bright ones above for
  // fills. #3B82F6 measures 3.68:1 on --info-light, which made an
  // informational heading the least readable line in its own banner.
  static const primaryText = Color(0xFF0B7F75);
  static const successText = Color(0xFF0B825A);
  static const warningText = Color(0xFF9D6507);
  static const dangerText = Color(0xFFCE3A3A);
  static const infoText = Color(0xFF1D4ED8);

  // Surfaces.
  static const background = Color(0xFFF8FAFC);
  static const surface = Color(0xFFFFFFFF);
  static const surface2 = Color(0xFFF1F5F9);   // --surface-hover
  static const border = Color(0xFFE2E8F0);
  static const borderLight = Color(0xFFF1F5F9);
  static const shadow = Color(0x14000000);

  // Ink. Very dark teal rather than slate: it belongs to this palette and
  // measures 15.9:1 on the page ground. textMuted was #94A3B8 at 2.45:1,
  // which fails AA even at large sizes -- readers here often have reduced
  // contrast sensitivity, so muted must still be readable.
  static const textPrimary = Color(0xFF0E2B29);     // 15.9:1
  static const textSecondary = Color(0xFF4D5A66);   //  7.4:1
  static const textMuted = Color(0xFF5F6B76);       //  5.6:1
  static const textInverse = Color(0xFFFFFFFF);

  // Amber-as-words, kept because screens still reference it. In this palette
  // that meaning is --warning-text.
  static const accentText = warningText;
}

class AppTheme {
  /// Display sizes in Outfit, body in Outfit -- the pairing
  /// tokens.css names. Both have plain zeros, so times read cleanly.
  static TextTheme _text(TextTheme body) {
    TextStyle? d(TextStyle? s) =>
        GoogleFonts.outfit(textStyle: s, fontWeight: FontWeight.w700);
    return body.copyWith(
      displayLarge: d(body.displayLarge),
      displayMedium: d(body.displayMedium),
      displaySmall: d(body.displaySmall),
      headlineLarge: d(body.headlineLarge),
      headlineMedium: d(body.headlineMedium),
      headlineSmall: d(body.headlineSmall),
      titleLarge: d(body.titleLarge),
    );
  }

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
      textTheme: _text(GoogleFonts.outfitTextTheme()).apply(
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
          fontWeight: FontWeight.w700,
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
          foregroundColor: AppColors.onPrimary,
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
        fillColor: AppColors.surface,
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
        backgroundColor: AppColors.surface,
        selectedItemColor: AppColors.primary,
        unselectedItemColor: AppColors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
      ),
      dividerTheme: const DividerThemeData(color: AppColors.borderLight, thickness: 1),
      chipTheme: ChipThemeData(
        showCheckmark: false,
        backgroundColor: AppColors.borderLight,
        labelStyle: GoogleFonts.outfit(fontSize: 13, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        side: BorderSide.none,
      ),
    );
  }

  static ThemeData get locusLight => _locus(LocusPalette.light);

  static ThemeData _locus(LocusPalette p) {
    final body = GoogleFonts.outfitTextTheme();
    TextStyle? display(TextStyle? s) =>
        GoogleFonts.outfit(textStyle: s, fontWeight: FontWeight.w700);
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
        primary: p.primary,
        onPrimary: p.onPrimary,
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
          backgroundColor: p.primary,
          foregroundColor: p.onPrimary,
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
        style: TextButton.styleFrom(foregroundColor: p.primary, minimumSize: tap),
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
          borderSide: BorderSide(color: p.primary, width: 2),
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
/// checked at >= 4.5:1. Teal [primary] is for actions; amber [accent] is a
/// fill only, and text in that hue uses [accentText].
class LocusPalette {
  final Brightness brightness;
  final Color bg, surface, surface2, border, text, text2, textMuted;
  final Color primary, onPrimary, accent, onAccent, accentText, shadow;
  final LocusStatus status;
  const LocusPalette({
    required this.brightness,
    required this.bg, required this.surface, required this.surface2,
    required this.border, required this.text, required this.text2,
    required this.textMuted, required this.primary, required this.onPrimary,
    required this.accent, required this.onAccent,
    required this.accentText, required this.shadow, required this.status,
  });


  static const light = LocusPalette(
    brightness: Brightness.light,
    bg: AppColors.background, surface: AppColors.surface,
    surface2: AppColors.surface2,
    border: AppColors.border, text: AppColors.textPrimary,
    text2: AppColors.textSecondary, textMuted: AppColors.textMuted,
    primary: AppColors.primary, onPrimary: AppColors.onPrimary,
    accent: AppColors.accent,
    onAccent: AppColors.textPrimary, accentText: AppColors.accentText,
    shadow: AppColors.shadow,
    status: LocusStatus(
      taken: AppColors.success, takenBg: AppColors.successLight,
      verify: AppColors.info, verifyBg: AppColors.infoLight,
      missed: Color(0xFF8A3874), missedBg: Color(0xFFF4E4EF),
      cameraOff: Color(0xFF535C68), cameraOffBg: Color(0xFFE8EAEE),
      danger: AppColors.danger, dangerBg: AppColors.dangerLight,
    ),
  );

}
