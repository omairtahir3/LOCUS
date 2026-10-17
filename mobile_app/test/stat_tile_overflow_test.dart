// Does the "Social Interactions" tile overflow, and in which direction?
//
// Reported three times as 10 px off the RIGHT, and twice I fixed something
// else because I reasoned about the geometry instead of measuring it. A Row
// whose long child is Expanded cannot overflow horizontally, so either my
// model of the layout is wrong or the overflow is somewhere I have not looked.
// This reproduces the tile exactly as activity_feed_screen builds it and lets
// Flutter say.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Copied from _stat in activity_feed_screen.dart. Kept in step by hand; if
/// that widget changes shape this test is measuring the old one.
Widget statTile(IconData icon, Color color, String value, String label) =>
    Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.grey),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10)),
            child: Icon(icon, size: 18, color: color),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(value,
                      style: const TextStyle(
                          fontSize: 20, fontWeight: FontWeight.w700)),
                ),
                Text(label,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11, color: Colors.grey)),
              ],
            ),
          ),
        ],
      ),
    );

Future<void> _pumpGrid(WidgetTester tester, double scale) async {
  tester.view.physicalSize = const Size(720, 1600);
  tester.view.devicePixelRatio = 2.0; // => 360 x 800 logical
  addTearDown(tester.view.reset);

  await tester.pumpWidget(MaterialApp(
    home: Builder(builder: (context) {
      final mq = MediaQuery.of(context);
      return MediaQuery(
        data: mq.copyWith(textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          body: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              GridView(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate:
                    const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 2,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  mainAxisExtent: 104,
                ),
                children: [
                  statTile(Icons.medication_outlined, Colors.green, '3',
                      'Doses Seen'),
                  statTile(Icons.psychology_outlined, Colors.purple, '12',
                      'Social Interactions'),
                  statTile(Icons.directions_walk_outlined, Colors.blue, '4,312',
                      'Steps Today'),
                  statTile(Icons.inventory_2_outlined, Colors.teal, '7',
                      'Items Found'),
                ],
              ),
            ],
          ),
        ),
      );
    }),
  ));
}

void main() {
  for (final scale in <double>[1.0, 1.3]) {
    testWidgets('stat tiles at text scale $scale', (tester) async {
      final errors = <String>[];
      final previous = FlutterError.onError;
      FlutterError.onError = (details) => errors.add(details.exceptionAsString());
      await _pumpGrid(tester, scale);
      FlutterError.onError = previous;

      // ignore: avoid_print
      print('--- text scale $scale: ${errors.length} layout error(s)');
      for (final e in errors) {
        // ignore: avoid_print
        print('    $e');
      }
      expect(errors, isEmpty,
          reason: 'the tile must fit its text at this scale; it overflowed by '
              '10px at 1.0 and 26px at 1.3 when the height came from '
              'childAspectRatio: 2.0');
    });
  }
}
