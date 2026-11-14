import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// The web dashboard's bento pattern, as Flutter widgets.
///
/// Both web dashboards -- the wearer's /my-dashboard and the caregiver's
/// /dashboard -- render the same `DaySummary` component, so there is one
/// pattern here rather than two, and the caregiver page simply adds its own
/// sections below it.
///
/// The grid is NOT part of the pattern on a phone. index.css collapses it at
/// 720px:
///
///     @media (max-width: 720px) {
///       .bento { grid-template-columns: 1fr; gap: 14px; }
///       .bento-card.is-wide { grid-column: auto; }
///     }
///
/// so a single column of cards IS the web layout at this width. What actually
/// distinguishes the pattern is the head block (date, greeting, one status
/// sentence, a row of pills), the card head (an icon in a tinted chip, a
/// title, and a right-aligned action with a chevron), and the empty state.
/// Those are what this file carries over; measurements come from index.css.

/// `.bento-head` -- date, who, one sentence about the day, then the pills.
class BentoHead extends StatelessWidget {
  const BentoHead({
    super.key,
    required this.date,
    required this.greeting,
    required this.status,
    this.initial,
    this.pills = const [],
  });

  final String date;
  final String greeting;
  final String status;
  final String? initial;
  final List<Widget> pills;

  @override
  Widget build(BuildContext context) {
    return Padding(
      // .bento-head { padding: 4px 0 2px; }
      padding: const EdgeInsets.only(top: 4, bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // .bento-date -- text-sm, secondary
          Text(date, style: const TextStyle(fontSize: 14, color: AppColors.textSecondary)),
          const SizedBox(height: 2),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (initial != null) ...[
                Container(
                  width: 44,
                  height: 44,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: AppColors.primaryLight,
                    shape: BoxShape.circle,
                    border: Border.all(color: AppColors.primary.withAlpha(50)),
                  ),
                  child: Text(
                    initial!,
                    style: const TextStyle(
                      fontSize: 19, fontWeight: FontWeight.w700,
                      color: AppColors.primaryDark,
                    ),
                  ),
                ),
                const SizedBox(width: LocusTokens.space3),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // .bento-greeting -- text-2xl, 600, tight
                    Text(
                      greeting,
                      style: const TextStyle(
                        fontSize: 24, fontWeight: FontWeight.w600,
                        letterSpacing: -0.35, height: 1.2,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 6),
                    // .bento-status -- the ONE sentence, text-lg, primary ink.
                    // About the day, not about doses.
                    Text(status,
                        style: const TextStyle(fontSize: 18, color: AppColors.textPrimary)),
                  ],
                ),
              ),
            ],
          ),
          if (pills.isNotEmpty) ...[
            // .pill-row { gap: 8px; margin: 14px 0 0; }
            const SizedBox(height: 14),
            Wrap(spacing: 8, runSpacing: 8, children: pills),
          ],
        ],
      ),
    );
  }
}

/// How a pill reads. Colour is never the only signal: each carries an icon
/// and a word, the rule the status tokens are written under.
enum PillTone { on, off, away, alert, plain }

/// `.pill` -- a small rounded fact about right now.
class BentoPill extends StatelessWidget {
  const BentoPill({
    super.key,
    required this.icon,
    required this.label,
    this.sub,
    this.tone = PillTone.plain,
  });

  final IconData icon;
  final String label;
  final String? sub;
  final PillTone tone;

  @override
  Widget build(BuildContext context) {
    final ink = switch (tone) {
      PillTone.on => AppColors.success,
      PillTone.off => AppColors.textSecondary,
      PillTone.away => AppColors.accentText,
      PillTone.alert => AppColors.danger,
      PillTone.plain => AppColors.textSecondary,
    };
    return Container(
      // .pill { padding: 7px 13px; border-radius: full; }
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(LocusTokens.radiusPill),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: ink),
          const SizedBox(width: 7),
          Text(label,
              style: TextStyle(
                  fontSize: 14, fontWeight: FontWeight.w500, color: ink)),
          if (sub != null) ...[
            const SizedBox(width: 6),
            Text(sub!,
                style: const TextStyle(fontSize: 13, color: AppColors.textMuted)),
          ],
        ],
      ),
    );
  }
}

/// `.bento-card` -- a surface with a head: chip, title, and an action.
class BentoCard extends StatelessWidget {
  const BentoCard({
    super.key,
    required this.icon,
    required this.title,
    required this.child,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final Widget child;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      // .bento-card { padding: 16px 18px 18px; }
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(LocusTokens.radiusLg),
        border: Border.all(color: AppColors.border),
        boxShadow: const [
          BoxShadow(color: AppColors.shadow, blurRadius: 10, offset: Offset(0, 2)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // .card-chip -- 30x30, radius 10, teal tint, dark teal glyph
              Container(
                width: 30,
                height: 30,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.primaryLight,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.primary.withAlpha(51)),
                ),
                child: Icon(icon, size: 15, color: AppColors.primaryDark),
              ),
              const SizedBox(width: LocusTokens.space2),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(
                      fontSize: 17, fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary),
                ),
              ),
              if (actionLabel != null && onAction != null)
                TextButton(
                  onPressed: onAction,
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    minimumSize: const Size(0, 36),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Row(
                    children: [
                      Text(actionLabel!,
                          style: const TextStyle(
                              fontSize: 14, fontWeight: FontWeight.w600,
                              color: AppColors.primaryDark)),
                      const Icon(Icons.chevron_right,
                          size: 16, color: AppColors.primaryDark),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: LocusTokens.space3),
          child,
        ],
      ),
    );
  }
}

/// `.card-empty` -- a disc, a sentence, and somewhere to go about it. An
/// empty card says what is missing and what to do, never just "no data".
class CardEmpty extends StatelessWidget {
  const CardEmpty({
    super.key,
    required this.icon,
    required this.text,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: LocusTokens.space3),
      child: Column(
        children: [
          Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.surface2, shape: BoxShape.circle),
            child: Icon(icon, size: 20, color: AppColors.textMuted),
          ),
          const SizedBox(height: LocusTokens.space3),
          Text(text,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 14, color: AppColors.textSecondary)),
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(height: LocusTokens.space2),
            TextButton(onPressed: onAction, child: Text(actionLabel!)),
          ],
        ],
      ),
    );
  }
}

/// `.bento-banner` -- the one thing pinned above everything else.
class BentoBanner extends StatelessWidget {
  const BentoBanner({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.emergency = false,
    this.actions = const [],
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool emergency;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final ink = emergency ? AppColors.danger : AppColors.primaryDark;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(LocusTokens.space4),
      decoration: BoxDecoration(
        color: emergency ? AppColors.dangerLight : AppColors.primaryLight,
        borderRadius: BorderRadius.circular(LocusTokens.radiusLg),
        border: Border.all(color: ink.withAlpha(60)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 24, color: ink),
              const SizedBox(width: LocusTokens.space3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: TextStyle(
                            fontSize: 17, fontWeight: FontWeight.w700, color: ink)),
                    const SizedBox(height: 2),
                    Text(subtitle,
                        style: const TextStyle(
                            fontSize: 14, color: AppColors.textSecondary)),
                  ],
                ),
              ),
            ],
          ),
          if (actions.isNotEmpty) ...[
            const SizedBox(height: LocusTokens.space3),
            Wrap(spacing: LocusTokens.space2, runSpacing: LocusTokens.space2,
                children: actions),
          ],
        ],
      ),
    );
  }
}
