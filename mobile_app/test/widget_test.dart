import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:locus_mobile/main.dart';

void main() {
  testWidgets('App loads without crashing', (WidgetTester tester) async {
    await tester.pumpWidget(const LocusApp());
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
