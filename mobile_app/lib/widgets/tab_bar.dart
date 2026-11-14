import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// The web's `.tabbar`, which is what the dock becomes under 900px.
///
/// It is a FLOATING bar, not an edge-to-edge one: index.css insets it 12px on
/// each side and 12px plus the safe area from the bottom, rounds it to
/// --radius-xl, fills it with white at 86% behind a blur, and gives it a
/// 1px white border and two stacked shadows. The active destination is a
/// teal-tinted chip rather than a coloured glyph, so which tab you are on
/// survives greyscale.
///
///     .tabbar { left: 12px; right: 12px; bottom: 12px + safe-area;
///               padding: 6px; border-radius: 24px;
///               background: rgba(255,255,255,.86); backdrop-filter: blur(16px) }
///     .tabbar a { min-height: 52px; border-radius: 12px; font-size: 13px }
///     .tabbar a.is-active { background: var(--primary-light);
///                           color: var(--primary-dark); font-weight: 600 }
///
/// Bottom rather than top for the reason the web gives: on a phone held
/// one-handed the top of the screen is the hardest place to reach, and this
/// audience includes people with limited dexterity.
class LocusTabBar extends StatelessWidget {
  const LocusTabBar({
    super.key,
    required this.items,
    required this.currentIndex,
    required this.onTap,
  });

  final List<LocusTab> items;
  final int currentIndex;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).padding.bottom;
    return Padding(
      padding: EdgeInsets.only(left: 12, right: 12, bottom: 12 + bottom),
      child: ClipRRect(
        // --radius-xl
        borderRadius: BorderRadius.circular(24),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 16, sigmaY: 16),
          child: Container(
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: AppColors.surface.withValues(alpha: 0.86),
              borderRadius: BorderRadius.circular(24),
              border: Border.all(color: Colors.white.withValues(alpha: 0.9)),
              boxShadow: const [
                BoxShadow(color: Color(0x120D504C), blurRadius: 6, offset: Offset(0, 2)),
                BoxShadow(color: Color(0x420D504C), blurRadius: 36, offset: Offset(0, 16), spreadRadius: -14),
              ],
            ),
            child: Row(
              children: [
                for (var i = 0; i < items.length; i++)
                  Expanded(child: _tab(context, i)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _tab(BuildContext context, int i) {
    final it = items[i];
    final active = i == currentIndex;
    return Semantics(
      selected: active,
      button: true,
      label: it.label,
      child: InkWell(
        onTap: () => onTap(i),
        // --radius-md
        borderRadius: BorderRadius.circular(12),
        child: Container(
          // 52px floor. 44 is the touch minimum and this audience includes
          // people with tremor; nothing here goes below it.
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
          decoration: BoxDecoration(
            color: active ? AppColors.primaryLight : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(active ? it.activeIcon : it.icon,
                  size: 20,
                  color: active ? AppColors.primaryDark : AppColors.textSecondary),
              const SizedBox(height: 3),
              // --text-xs, the 13px floor. Ellipsised rather than shrunk: a
              // label below the floor is one this audience cannot read.
              Text(
                it.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                  color: active ? AppColors.primaryDark : AppColors.textSecondary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class LocusTab {
  const LocusTab({required this.icon, required this.activeIcon, required this.label});
  final IconData icon;
  final IconData activeIcon;
  final String label;
}
