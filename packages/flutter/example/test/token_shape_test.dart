import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:dhaam_chat_flutter_example/token_shape.dart';

String _jwt(Map<String, Object?> claims) {
  String seg(Object o) =>
      base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  return '${seg(<String, String>{'alg': 'RS256'})}.${seg(claims)}.sig';
}

void main() {
  test('names a Cognito ID token, which is the reported foot-gun', () {
    final String? hint = describeSuspiciousToken(_jwt(<String, Object?>{
      'token_use': 'id',
      'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_rc792gbnn',
    }));

    expect(hint, isNotNull);
    expect(hint, contains('identity-provider token'));
    // The whole point is telling them what to do instead, not just what is
    // wrong — the server already says "Authentication failed".
    expect(hint, contains('/chat-services/api/v1/tokens'));
    expect(hint, contains('dhk_'));
  });

  test('catches an IdP token by issuer even without token_use', () {
    expect(
      describeSuspiciousToken(_jwt(<String, Object?>{
        'iss': 'https://cognito-idp.eu-west-1.amazonaws.com/pool',
      })),
      isNotNull,
    );
  });

  test('says nothing about a token that carries no IdP marks', () {
    // A minted chat token is opaque to this example. Complaining about
    // anything it cannot positively identify as wrong would make the hint
    // noise, and noise is what gets ignored on the day it matters.
    expect(
      describeSuspiciousToken(_jwt(<String, Object?>{'sub': 'u1', 'exp': 1})),
      isNull,
    );
  });

  test('says nothing about a non-JWT, rather than inventing a complaint', () {
    // The mint endpoint's output format is not this example's to assert.
    for (final String t in <String>['', 'opaque-token', 'a.b', 'a.b.c.d']) {
      expect(describeSuspiciousToken(t), isNull, reason: 'input: "$t"');
    }
  });

  test('survives a malformed payload without throwing', () {
    expect(describeSuspiciousToken('aGVhZGVy.!!!not-base64!!!.sig'), isNull);
  });
}
