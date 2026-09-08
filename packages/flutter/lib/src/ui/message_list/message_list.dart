/// The transcript: its ticks, its retry affordance, its per-message menu,
/// and the announcement channel behind it. The Flutter counterpart of
/// `packages/widget/src/ui/message-list.ts` and `ui/message-actions.ts`.
///
/// ── Ticks come from `deriveTickState`, always ────────────────────────────
///
/// Nothing in this module computes anything about delivery: not from
/// presence, not from `seq` alone, not "is the agent online". That is the
/// exact bug v1 shipped — it drew the double tick from connectivity, which
/// is a claim about a socket rather than about a message. `tick_state.dart`
/// holds the one derivation and every other file here consumes its answer.
///
/// ── The projection is the deep part; the widgets are thin over it ────────
///
/// [MessageListPresenter] turns a state snapshot into [MessageRow]s and, at
/// most, one announcement. Every rule the acceptance criteria name — the
/// §12.10 placeholder, `retryable` never re-derived, the per-run author
/// name, the per-row avatar, the announce watermark, the remembered bot name
/// — lives behind that one call, which is what lets them be asserted without
/// pumping a widget and what stops a second copy of any of them appearing in
/// the render path.
///
/// `quick_reply_options.dart` is deliberately NOT re-exported here: it is
/// re-exported by `../quick_replies.dart`, which is the import every
/// existing call site already uses, and one export path is what keeps the
/// parse a single declaration.
library;

export 'delivery_failure.dart';
export 'linkified_text.dart';
export 'message_actions.dart';
export 'message_content.dart';
export 'message_list_presenter.dart';
export 'message_list_view.dart';
export 'message_row.dart';
export 'reply_quote.dart';
export 'scroll_anchor.dart';
export 'sender_label.dart';
export 'tick_state.dart';
export 'typing_indicator.dart';
