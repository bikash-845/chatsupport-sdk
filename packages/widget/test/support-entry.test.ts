// node, pure. Mirrors remote-config.test.ts's exhaustive-parse style.
//
// This is the widget half of AC18 (all six PRD rows render the right thing)
// and AC19 (NO_CALENDAR resolves the same as OPEN) — chat-service resolves
// the six-row table authoritatively (`decideWebformOutcome`); this suite
// asserts the widget renders what the server said, and nothing more.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REMOTE_CONFIG,
  OFFLINE_MODE,
  entryFor,
  parseSupport,
  shouldMount,
} from '../src/remote-config.js';
import type { RemoteConfig } from '../src/remote-config.js';

function remote(overrides: Partial<RemoteConfig> = {}): RemoteConfig {
  return { ...DEFAULT_REMOTE_CONFIG, ...overrides };
}

describe('parseSupport', () => {
  it('reads a well-formed entry, all three fields', () => {
    expect(parseSupport({ primary: 'chat', secondary: 'ticket', hours: 'OPEN' })).toEqual({
      primary: 'chat',
      secondary: 'ticket',
      hours: 'OPEN',
    });
  });

  it('defaults an absent secondary to null rather than refusing the object', () => {
    expect(parseSupport({ primary: 'ticket', hours: 'CLOSED' })).toEqual({
      primary: 'ticket',
      secondary: null,
      hours: 'CLOSED',
    });
  });

  it('refuses a non-object', () => {
    expect(parseSupport('chat')).toBeNull();
    expect(parseSupport(null)).toBeNull();
    expect(parseSupport(undefined)).toBeNull();
    expect(parseSupport([])).toBeNull();
  });

  it('refuses a missing primary', () => {
    expect(parseSupport({ hours: 'OPEN' })).toBeNull();
  });

  it('refuses an unrecognised primary — a future server’s vocabulary is not this bundle’s', () => {
    expect(parseSupport({ primary: 'callback', hours: 'OPEN' })).toBeNull();
  });

  it('refuses an unrecognised hours value', () => {
    expect(parseSupport({ primary: 'chat', hours: 'LUNCH' })).toBeNull();
  });

  it('degrades an unrecognised secondary to null rather than refusing the whole object', () => {
    expect(parseSupport({ primary: 'chat', secondary: 'callback', hours: 'OPEN' })).toEqual({
      primary: 'chat',
      secondary: null,
      hours: 'OPEN',
    });
  });
});

describe('entryFor — the six PRD rows', () => {
  it('row 1: chat + ticket, open — chat default', () => {
    const entry = entryFor(remote({ support: { primary: 'chat', secondary: 'ticket', hours: 'OPEN' } }));
    expect(entry).toEqual({ primary: 'chat', secondary: 'ticket', hours: 'OPEN', source: 'published' });
  });

  it('row 1 under NO_CALENDAR resolves identically to OPEN — AC19', () => {
    const open = entryFor(remote({ support: { primary: 'chat', secondary: 'ticket', hours: 'OPEN' } }));
    const noCalendar = entryFor(
      remote({ support: { primary: 'chat', secondary: 'ticket', hours: 'NO_CALENDAR' } }),
    );
    expect(noCalendar).toEqual({ ...open, hours: 'NO_CALENDAR' });
  });

  it('row 2: ticket + chat, closed — ticket default', () => {
    const entry = entryFor(remote({ support: { primary: 'ticket', secondary: 'chat', hours: 'CLOSED' } }));
    expect(entry).toEqual({ primary: 'ticket', secondary: 'chat', hours: 'CLOSED', source: 'published' });
  });

  it('row 3: chat only', () => {
    const entry = entryFor(remote({ support: { primary: 'chat', secondary: null, hours: 'OPEN' } }));
    expect(entry).toEqual({ primary: 'chat', secondary: null, hours: 'OPEN', source: 'published' });
  });

  it('row 4: offline — WidgetOfflineMode’s to own, not a submission destination', () => {
    const entry = entryFor(remote({ support: { primary: 'offline', secondary: null, hours: 'CLOSED' } }));
    expect(entry).toEqual({ primary: 'offline', secondary: null, hours: 'CLOSED', source: 'published' });
  });

  it('row 5: ticket only, hours irrelevant to the offer itself', () => {
    const entry = entryFor(remote({ support: { primary: 'ticket', secondary: null, hours: 'OPEN' } }));
    expect(entry).toEqual({ primary: 'ticket', secondary: null, hours: 'OPEN', source: 'published' });
  });

  it('row 6: none — no support entry point at all', () => {
    const entry = entryFor(remote({ support: { primary: 'none', secondary: null, hours: 'OPEN' } }));
    expect(entry).toEqual({ primary: 'none', secondary: null, hours: 'OPEN', source: 'published' });
  });

  it('support: null degrades to the pre-chooser assumption: chat, source "assumed"', () => {
    expect(entryFor(remote({ support: null }))).toEqual({
      primary: 'chat',
      secondary: null,
      hours: 'UNKNOWN',
      source: 'assumed',
    });
  });
});

describe('shouldMount — the compatibility guarantee', () => {
  // The exact pre-chooser rule, spelled out rather than imported, so a change
  // to either side is caught. This is what makes it safe to ship the chooser
  // before chat-service publishes `support` at all (every deployment, on the
  // day this ships) — see remote-config.ts's own comment on `shouldMount`.
  function legacyShouldMount(cfg: RemoteConfig): boolean {
    return cfg.enabled && !(cfg.offlineMode === OFFLINE_MODE.HIDE_WIDGET && cfg.isOpenNow === false);
  }

  it('matches the pre-chooser rule exactly, for every enabled × offlineMode × isOpenNow combination, with support: null', () => {
    const offlineModes = [OFFLINE_MODE.SHOW_MESSAGE, OFFLINE_MODE.COLLECT_MESSAGE, OFFLINE_MODE.HIDE_WIDGET];
    const isOpenNowValues: Array<boolean | null> = [true, false, null];

    for (const enabled of [true, false]) {
      for (const offlineMode of offlineModes) {
        for (const isOpenNow of isOpenNowValues) {
          const cfg = remote({ enabled, offlineMode, isOpenNow, support: null });
          expect(shouldMount(cfg), JSON.stringify({ enabled, offlineMode, isOpenNow })).toBe(
            legacyShouldMount(cfg),
          );
        }
      }
    }
  });

  it('row 4 (chat only, closed): HIDE_WIDGET still hides — today’s rule, unchanged', () => {
    const cfg = remote({
      offlineMode: OFFLINE_MODE.HIDE_WIDGET,
      isOpenNow: false,
      support: { primary: 'offline', secondary: null, hours: 'CLOSED' },
    });
    expect(shouldMount(cfg)).toBe(false);
  });

  it('row 5 (ticket only): HIDE_WIDGET does NOT hide — the setting is about chat, and row 5 never offered it', () => {
    const cfg = remote({
      offlineMode: OFFLINE_MODE.HIDE_WIDGET,
      isOpenNow: false,
      support: { primary: 'ticket', secondary: null, hours: 'OPEN' },
    });
    expect(shouldMount(cfg)).toBe(true);
  });

  it('row 6 (none): always hides, regardless of offlineMode/isOpenNow', () => {
    for (const offlineMode of [OFFLINE_MODE.SHOW_MESSAGE, OFFLINE_MODE.COLLECT_MESSAGE, OFFLINE_MODE.HIDE_WIDGET]) {
      for (const isOpenNow of [true, false, null] as const) {
        const cfg = remote({
          offlineMode,
          isOpenNow,
          support: { primary: 'none', secondary: null, hours: 'OPEN' },
        });
        expect(shouldMount(cfg), JSON.stringify({ offlineMode, isOpenNow })).toBe(false);
      }
    }
  });

  it('enabled: false hides regardless of the entry', () => {
    const cfg = remote({ enabled: false, support: { primary: 'chat', secondary: 'ticket', hours: 'OPEN' } });
    expect(shouldMount(cfg)).toBe(false);
  });

  it('rows 1, 2 and 3 always mount, whatever offlineMode/isOpenNow say', () => {
    const rows: ReadonlyArray<{ primary: 'chat' | 'ticket'; secondary: 'chat' | 'ticket' | null }> = [
      { primary: 'chat', secondary: 'ticket' },
      { primary: 'ticket', secondary: 'chat' },
      { primary: 'chat', secondary: null },
    ];
    for (const row of rows) {
      for (const offlineMode of [OFFLINE_MODE.SHOW_MESSAGE, OFFLINE_MODE.COLLECT_MESSAGE, OFFLINE_MODE.HIDE_WIDGET]) {
        const cfg = remote({
          offlineMode,
          isOpenNow: false,
          support: { ...row, hours: 'CLOSED' },
        });
        expect(shouldMount(cfg), JSON.stringify(row)).toBe(true);
      }
    }
  });

  it('a malformed/unknown support.primary from a future server degrades to the assumed rule rather than crashing', () => {
    // parseRemoteConfig would already turn this into `support: null` before it
    // ever reaches shouldMount — this asserts the same safety directly against
    // entryFor/shouldMount, since RemoteConfig itself only ever carries a
    // parsed (or null) SupportEntry.
    const cfg = remote({ support: null, offlineMode: OFFLINE_MODE.HIDE_WIDGET, isOpenNow: false });
    expect(() => shouldMount(cfg)).not.toThrow();
    expect(shouldMount(cfg)).toBe(false);
  });
});

// The chooser's published surface (design §11) — a smoke test that these
// actually resolve through the package's ONE entry point, `@dhaam-ccrm/
// widget`, rather than only existing as internal exports the design promised
// a host could import and nobody wired up.
describe('the chooser is published from the package entry point', () => {
  it('entryFor, parseSupport and shouldMount are reachable from ../src/index.js', async () => {
    const pkg = await import('../src/index.js');
    expect(pkg.entryFor(DEFAULT_REMOTE_CONFIG)).toEqual({
      primary: 'chat',
      secondary: null,
      hours: 'UNKNOWN',
      source: 'assumed',
    });
    expect(pkg.parseSupport({ primary: 'ticket', hours: 'OPEN' })).toEqual({
      primary: 'ticket',
      secondary: null,
      hours: 'OPEN',
    });
    expect(pkg.shouldMount(DEFAULT_REMOTE_CONFIG)).toBe(true);
  });

  it('submitWebform, visitorMessage, WebformError and the webform constants are reachable from ../src/index.js', async () => {
    const pkg = await import('../src/index.js');
    expect(typeof pkg.submitWebform).toBe('function');
    expect(typeof pkg.visitorMessage).toBe('function');
    expect(pkg.visitorMessage(new pkg.WebformError('network', '', true))).not.toBe('');
    expect(pkg.WEBFORM_PATH).toBe('/chat-services/api/v1/widget/webform');
    expect(typeof pkg.WEBFORM_TIMEOUT_MS).toBe('number');
  });
});
