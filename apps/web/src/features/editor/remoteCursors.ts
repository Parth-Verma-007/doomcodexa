import type { Awareness } from 'y-protocols/awareness';
import type { AwarenessState } from '@codexa/shared';
import { readableTextOn } from '../../lib/utils.js';

/**
 * Per-peer cursor styling.
 *
 * `y-monaco` draws remote selections as decorations with the class names
 * `yRemoteSelection-<clientId>` and `yRemoteSelectionHead-<clientId>`, but it
 * deliberately ships no CSS — the colours belong to the application. A Monaco
 * decoration also cannot carry arbitrary attributes, so `content: attr(...)`
 * is not available for the name label either.
 *
 * So we generate one stylesheet rule per peer, keyed by client id, and rewrite
 * it whenever the awareness roster changes. It is a handful of rules for a
 * handful of peers, replaced wholesale rather than diffed.
 */

const STYLE_ELEMENT_ID = 'codexa-remote-cursors';

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;

  const element = document.createElement('style');
  element.id = STYLE_ELEMENT_ID;
  document.head.appendChild(element);
  return element;
}

/** CSS string literals are a real injection vector — usernames come from users. */
function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function isSafeColor(value: string): boolean {
  return /^#[0-9a-f]{3,8}$/i.test(value);
}

export function syncRemoteCursorStyles(awareness: Awareness): void {
  const rules: string[] = [];

  for (const [clientId, raw] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;

    const state = raw as Partial<AwarenessState>;
    const user = state.user;
    if (!user) continue;

    const color = isSafeColor(user.color) ? user.color : '#4c8dff';
    const name = escapeCssString(user.username || 'Anonymous');

    rules.push(`
      .yRemoteSelection-${clientId} {
        background-color: ${color};
        opacity: 0.28;
        border-radius: 2px;
      }
      .yRemoteSelectionHead-${clientId} {
        position: relative;
        border-left: 2px solid ${color};
        border-top: 2px solid ${color};
        border-bottom: 2px solid ${color};
        margin-left: -1px;
        box-sizing: border-box;
        z-index: 6;
      }
      .yRemoteSelectionHead-${clientId}::after {
        content: "${name}";
        position: absolute;
        top: -1.25em;
        left: -2px;
        padding: 0 4px;
        font-family: var(--font-sans);
        font-size: 11px;
        line-height: 1.2em;
        white-space: nowrap;
        border-radius: 3px 3px 3px 0;
        background-color: ${color};
        color: ${readableTextOn(color)};
        pointer-events: none;
        z-index: 7;
      }
    `);
  }

  styleElement().textContent = rules.join('\n');
}

export function clearRemoteCursorStyles(): void {
  const element = document.getElementById(STYLE_ELEMENT_ID);
  element?.remove();
}
