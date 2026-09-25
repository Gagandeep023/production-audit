import type { CallSite, Observation, ObservedSetting } from '../types/index';
import { arm, find, nextObservationId, record, update } from '../core/registry';
import { captureCallSite, formatCallSite } from '../core/stack';
import { explicit, unknown, unset } from '../core/settings';
import { FILLED_NOTE, plannedValue, policyMode, recordChange } from '../core/policy';

/**
 * Observes `globalThis.fetch`.
 *
 * `fetch` is a global, so this needs no module interception and works the same
 * under CJS and ESM. That is why it is the one part of the package a plain
 * `applySafeDefaults()` call covers completely.
 *
 * Observations are keyed by **call site**, not by the process. "Some fetch
 * somewhere has no timeout" is true and useless; "src/http/upstream.ts:22 has
 * no timeout and ran 400 times" is a thing somebody can fix.
 */

type FetchFn = typeof globalThis.fetch;

interface FetchState {
  installed: boolean;
  original: FetchFn | null;
  /** Call site key -> observation id. */
  sites: Map<string, string>;
  counts: Map<string, number>;
  /** Call sites already reported to the policy, so the log stays readable. */
  reported: Set<string>;
}

const state: FetchState = {
  installed: false,
  original: null,
  sites: new Map(),
  counts: new Map(),
  reported: new Set(),
};

/** Milliseconds `applySafeDefaults()` would give a call that passes no signal. */
function plannedTimeout(): { value: number; ruleId: string } | undefined {
  const planned = plannedValue('fetch', 'signal');
  if (planned === undefined || typeof planned.value !== 'number') return undefined;
  return { value: planned.value, ruleId: planned.ruleId };
}

function signalSetting(init: RequestInit | undefined): ObservedSetting {
  if (init?.signal != null) return explicit('AbortSignal');

  // A custom dispatcher can carry headersTimeout and bodyTimeout, and Node
  // does not expose them. Saying "no timeout" here would be a guess, so the
  // finding says unknown instead.
  if (init !== undefined && 'dispatcher' in init && init.dispatcher != null) {
    return unknown(
      'a custom dispatcher was passed; its headersTimeout and bodyTimeout are not readable from outside undici',
    );
  }
  return unset(undefined);
}

function observe(init: RequestInit | undefined, url: string, site: CallSite | undefined): void {
  const key = site === undefined ? url : formatCallSite(site);
  const uses = (state.counts.get(key) ?? 0) + 1;
  state.counts.set(key, uses);

  let observed = signalSetting(init);

  // A call with no signal is the thing `applySafeDefaults()` fills. Reported
  // once per call site rather than once per request, because a hot path would
  // otherwise turn the boot log into a flood.
  if (observed.state === 'unset') {
    const planned = plannedTimeout();
    if (planned !== undefined) {
      const enforcing = policyMode() === 'enforce';
      if (enforcing) {
        observed = { ...explicit(planned.value), note: FILLED_NOTE };
      }
      if (!state.reported.has(key)) {
        state.reported.add(key);
        recordChange({
          subsystem: 'fetch',
          target: 'globalThis.fetch',
          setting: 'signal',
          from: 'unset',
          to: planned.value,
          ruleId: planned.ruleId,
          applied: enforcing,
        });
      }
    }
  }

  const existingId = state.sites.get(key);

  if (existingId === undefined) {
    const observation: Observation = {
      id: nextObservationId('fetch'),
      subsystem: 'fetch',
      target: 'globalThis.fetch',
      library: 'undici',
      settings: { signal: observed },
      site,
      uses,
      observedAt: Date.now(),
    };
    state.sites.set(key, observation.id);
    record(observation);
    return;
  }

  const previous = find(existingId);
  if (previous === undefined) return;

  // One safe call does not clear a call site. If any request from this line
  // goes out without a timeout, the line is the problem, so the worst state
  // observed is the one that sticks.
  const previousSignal = previous.settings['signal'];
  const worst = worstOf(previousSignal, observed);

  update(existingId, { ...previous, settings: { signal: worst }, uses });
}

const SEVERITY_OF_STATE = { unset: 0, unknown: 1, explicit: 2 } as const;

function worstOf(a: ObservedSetting | undefined, b: ObservedSetting): ObservedSetting {
  if (a === undefined) return b;
  return SEVERITY_OF_STATE[a.state] <= SEVERITY_OF_STATE[b.state] ? a : b;
}

/**
 * Installs the wrapper. Idempotent, and safe to call in observe-only mode:
 * with `enforceTimeoutMs` null it passes `init` through untouched.
 */
export function installFetchObserver(): void {
  if (state.installed) return;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;

  state.original = original;
  state.installed = true;
  arm('fetch');

  const wrapped: FetchFn = function productionAuditFetch(input, init) {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
    try {
      // Captured here rather than inside `observe`, so the frame handed to
      // V8 is the wrapper the application actually called.
      observe(init as RequestInit | undefined, url, captureCallSite(wrapped));
    } catch {
      // Observation must never break the request it is watching.
    }

    // Only a call that passed no signal at all is touched. A caller who
    // supplied one made a choice, and a choice is never overridden.
    const planned = plannedTimeout();
    if (planned !== undefined && policyMode() === 'enforce' && init?.signal == null) {
      const withTimeout = { ...(init ?? {}), signal: AbortSignal.timeout(planned.value) };
      return (state.original as FetchFn)(input, withTimeout);
    }
    return (state.original as FetchFn)(input, init);
  };

  globalThis.fetch = wrapped;
}

export function isFetchObserverInstalled(): boolean {
  return state.installed;
}

/** Test-only. Restores the original global. */
export function uninstallFetchObserver(): void {
  if (!state.installed) return;
  if (state.original !== null) globalThis.fetch = state.original;
  state.installed = false;
  state.original = null;
  state.sites.clear();
  state.counts.clear();
  state.reported.clear();
}
