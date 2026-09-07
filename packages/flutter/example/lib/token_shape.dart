/// A developer-facing sanity check on the token handed to the example.
///
/// ── Why this exists, and why it is NOT in the SDK ───────────────────────
///
/// `POST /chat-services/api/v1/tokens` mints the token this SDK wants, and it
/// is called by the integrator's own BACKEND with their `dhk_…` secret key —
/// never by a client (openapi/chat-api.yaml:434, PRD §10.3). The frontend
/// receives only the resulting `accessToken`.
///
/// The failure mode this catches: handing the SDK an identity-provider token
/// instead — a Cognito ID token, say, which is right there in the app already
/// and looks exactly like a JWT. The server answers `AUTH_INVALID`, the client
/// correctly stops after its auth cap, and the developer is left staring at
/// "authentication failed repeatedly" with a token they can see is present and
/// unexpired. That is a real report, not a hypothetical.
///
/// It lives in the example, not in `dhaam_chat`, deliberately. A protocol
/// client has no business decoding the credential it was given: the token is
/// opaque to it by design, the server is the only authority on validity, and a
/// client that sniffed claims would be guessing at an issuer's private
/// contract. An example app diagnosing its own misconfiguration is a different
/// job from a library second-guessing its caller.
///
/// Nothing here verifies a signature or decides anything. It reads the
/// unverified payload for the sole purpose of writing a better sentence.
library;

import 'dart:convert';

/// A plain-language warning about the token's SHAPE, or null if it looks like
/// what the mint endpoint returns.
String? describeSuspiciousToken(String token) {
  final Map<String, Object?>? claims = _payloadOf(token);
  if (claims == null) {
    // Not decodable as a JWT. That is not itself wrong — the mint endpoint's
    // output is opaque and this example must not assert a format for it — so
    // this says nothing rather than inventing a complaint.
    return null;
  }

  final Object? use = claims['token_use'];
  final Object? issuer = claims['iss'];
  final bool looksLikeIdp =
      use == 'id' || use == 'access' || '$issuer'.contains('cognito-idp');

  if (!looksLikeIdp) return null;

  return 'This looks like an identity-provider token'
      '${use is String ? ' (token_use: "$use")' : ''}, not a chat access '
      'token.\n\n'
      'The chat service does not accept IdP tokens. Your BACKEND mints one '
      'with your dhk_… secret key:\n\n'
      '  POST /chat-services/api/v1/tokens\n'
      '  Authorization: Bearer <dhk_test_… secret key>\n'
      '  {"userId": "...", "name": "..."}\n\n'
      '  -> {"accessToken": "...", "expiresIn": 3600}\n\n'
      'Pass that accessToken as DHAAM_ACCESS_TOKEN. The secret key must never '
      'reach a client — that is why this endpoint is backend-only.';
}

/// The unverified payload of a JWT, or null if [token] is not one.
Map<String, Object?>? _payloadOf(String token) {
  final List<String> parts = token.split('.');
  if (parts.length != 3) return null;
  try {
    final String normalised = base64Url.normalize(parts[1]);
    final Object? decoded =
        jsonDecode(utf8.decode(base64Url.decode(normalised)));
    return decoded is Map<String, Object?> ? decoded : null;
  } catch (_) {
    // Malformed base64, non-JSON payload, non-UTF8 bytes. All mean the same
    // thing here: nothing useful to say, so say nothing.
    return null;
  }
}
