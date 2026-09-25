import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Observation } from '../types/index';
import { arm, find, nextObservationId, record, update } from '../core/registry';
import { isRecord, unknown } from '../core/settings';

/**
 * The one observer that patches nothing.
 *
 * `diagnostics_channel` is Node core and undici already publishes to it, so
 * outbound HTTP traffic can be watched with no interception at all. That is
 * why the reporting half of this package is safe to put in the boot path of a
 * production service before anything is allowed to modify it.
 *
 * What it can see has a real limit, stated here rather than glossed over: the
 * request payload carries the origin, method and path, and the timeouts live
 * on the dispatcher, which undici does not expose. So this observer reports
 * the traffic honestly and marks the dispatcher timeouts **unknown**. The
 * actionable finding about missing timeouts comes from the fetch observer,
 * which can see `init.signal`.
 */

const CHANNEL = 'undici:request:create';

const DISPATCHER_NOTE =
  'undici publishes the request but not the dispatcher, so headersTimeout and bodyTimeout are not readable from outside the library';

interface DiagnosticsState {
  installed: boolean;
  observationId: string | null;
  requests: number;
  origins: Set<string>;
  handler: ((message: unknown) => void) | null;
}

const state: DiagnosticsState = {
  installed: false,
  observationId: null,
  requests: 0,
  origins: new Set(),
  handler: null,
};

function originOf(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const request = message['request'];
  if (!isRecord(request)) return undefined;
  const origin = request['origin'];
  if (typeof origin === 'string') return origin;
  if (isRecord(origin) && typeof origin['origin'] === 'string') return origin['origin'];
  return undefined;
}

function publish(): void {
  const id = state.observationId;
  if (id === null) return;
  const previous = find(id);
  const observation: Observation = {
    id,
    subsystem: 'undici',
    target: 'undici.request',
    library: 'undici',
    settings: {
      headersTimeout: unknown(DISPATCHER_NOTE),
      bodyTimeout: unknown(DISPATCHER_NOTE),
    },
    uses: state.requests,
    observedAt: previous?.observedAt ?? Date.now(),
  };
  update(id, observation);
}

export function installDiagnosticsObserver(): void {
  if (state.installed) return;

  const handler = (message: unknown): void => {
    try {
      state.requests += 1;
      const origin = originOf(message);
      if (origin !== undefined) state.origins.add(origin);

      if (state.observationId === null) {
        state.observationId = nextObservationId('undici');
        record({
          id: state.observationId,
          subsystem: 'undici',
          target: 'undici.request',
          library: 'undici',
          settings: {
            headersTimeout: unknown(DISPATCHER_NOTE),
            bodyTimeout: unknown(DISPATCHER_NOTE),
          },
          uses: state.requests,
          observedAt: Date.now(),
        });
      } else {
        publish();
      }
    } catch {
      // Observation must never interfere with the request being observed.
    }
  };

  state.handler = handler;
  state.installed = true;
  subscribe(CHANNEL, handler);
  arm('undici');
}

/** Origins the process actually talked to. Shown as evidence, not a finding. */
export function observedOrigins(): string[] {
  return [...state.origins].sort();
}

export function observedRequestCount(): number {
  return state.requests;
}

export function isDiagnosticsObserverInstalled(): boolean {
  return state.installed;
}

/** Test-only. */
export function uninstallDiagnosticsObserver(): void {
  if (state.installed && state.handler !== null) unsubscribe(CHANNEL, state.handler);
  state.installed = false;
  state.handler = null;
  state.observationId = null;
  state.requests = 0;
  state.origins.clear();
}
