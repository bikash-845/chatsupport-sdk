// The admin's view of ONE real customer conversation, opened from the
// Customers tab's real queue data (see widget.ts's portal wiring, and
// `../portal/portal-staff-client.ts` for why this is a second client rather
// than a branch in the customer one).
//
// Deliberately NOT `message-list.ts` + `composer.ts` reused wholesale: those
// are built for the customer protocol's full feature set — attachments,
// voice, emoji, typing, CSAT, the offline send-retry queue — none of which
// `createConversationClient` (the staff protocol) supports in this SDK
// slice. This is the same "read a transcript, send text" shape
// chatsupport-sdk's own `examples/admin-panel` proves works end-to-end,
// wearing the widget's own `.dh-msg`/`.dh-composer` CSS classes (see
// `ui/styles.ts`) so it reads as the same product rather than a bolted-on
// second UI.

import type { ChatMessage, ChatState } from '@dhaam-ccrm/js';
import { ICONS, el, icon } from './dom.js';

export interface PortalThreadCallbacks {
  readonly onSend: (text: string) => Promise<void>;
}

export interface PortalThreadView {
  readonly node: HTMLElement;
  /**
   * Renders the conversation currently open.
   * `state === null` means nothing has opened yet (or `opening` is true and
   * the join is still in flight); `state.session === null` means the join
   * has not produced a usable session yet either.
   */
  render(state: ChatState | null, opening: boolean): void;
  /** A load/open/send failure banner above the transcript. `null` clears it. */
  setError(message: string | null): void;
  focus(): void;
}

/** The admin IS the agent on this surface — the inverse of `message-list.ts`'s own `isOutgoing`, which hardcodes CUSTOMER because that file only ever runs inside a customer's own widget. */
function isOutgoing(message: ChatMessage): boolean {
  return message.senderType === 'AGENT';
}

function renderBubble(message: ChatMessage): HTMLElement {
  const body = el('span', { attrs: { class: 'dh-msg-body' }, text: message.content });
  const bubble = el('div', { attrs: { class: 'dh-msg-bubble' }, children: [body] });
  const node = el('div', { attrs: { class: 'dh-msg' }, children: [bubble] });
  node.setAttribute('data-mine', String(isOutgoing(message)));
  return node;
}

export function createPortalThread(callbacks: PortalThreadCallbacks): PortalThreadView {
  const log = el('div', { attrs: { class: 'dh-message-log dh-portal-log', role: 'log' } });
  const errorLine = el('p', { attrs: { class: 'dh-composer-error', hidden: true } });

  const input = el('textarea', {
    attrs: {
      class: 'dh-input',
      rows: '1',
      placeholder: 'Type a reply…',
      'aria-label': 'Reply to customer',
      autocomplete: 'off',
    },
    on: {
      input: () => syncSendState(),
      keydown: (event) => {
        const key = event as KeyboardEvent;
        if (key.key === 'Enter' && !key.shiftKey && !key.isComposing) {
          key.preventDefault();
          void submit();
        }
      },
    },
  });

  const sendButton = el('button', {
    attrs: { class: 'dh-send', type: 'button', 'aria-label': 'Send reply', disabled: true },
    children: [icon(ICONS.send, 18)],
    on: { click: () => { void submit(); } },
  });

  const composerNode = el('div', {
    attrs: { class: 'dh-composer' },
    children: [
      errorLine,
      el('div', {
        attrs: { class: 'dh-composer-box' },
        children: [input, el('div', { attrs: { class: 'dh-composer-row' }, children: [sendButton] })],
      }),
    ],
  });

  const node = el('div', { attrs: { class: 'dh-portal-thread' }, children: [log, composerNode] });

  let sendable = false;
  let sending = false;

  function syncSendState(): void {
    sendButton.disabled = !sendable || sending || input.value.trim() === '';
  }

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (text === '' || !sendable || sending) return;
    sending = true;
    syncSendState();
    const draft = input.value;
    input.value = '';
    try {
      await callbacks.onSend(text);
      errorLine.hidden = true;
    } catch (error) {
      // Give the draft back — a failed send must not cost the admin what they typed.
      input.value = draft;
      errorLine.textContent = error instanceof Error ? error.message : 'Could not send the reply.';
      errorLine.hidden = false;
    } finally {
      sending = false;
      syncSendState();
    }
  }

  return {
    node,

    render(state, opening) {
      sendable = state !== null && state.session !== null;
      syncSendState();

      if (state === null || state.session === null) {
        log.replaceChildren(
          el('p', { attrs: { class: 'dh-messages-empty' }, text: opening ? 'Opening…' : 'Select a conversation.' }),
        );
        return;
      }
      if (state.messages.length === 0) {
        log.replaceChildren(
          el('p', { attrs: { class: 'dh-messages-empty' }, text: 'No messages in this conversation yet.' }),
        );
        return;
      }
      log.replaceChildren(...state.messages.map(renderBubble));
      log.scrollTop = log.scrollHeight;
    },

    setError(message) {
      errorLine.textContent = message ?? '';
      errorLine.hidden = message === null;
    },

    focus() {
      input.focus({ preventScroll: true });
    },
  };
}
