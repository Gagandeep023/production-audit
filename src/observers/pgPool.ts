import type { CallSite } from '../types/index';
import { arm, nextObservationId, record } from '../core/registry';
import { captureCallSite } from '../core/stack';
import { isRecord, settingsFromOptions } from '../core/settings';
import type { SettingSpec } from '../core/settings';
import { FILLED_NOTE, plannedValue, policyMode, recordChange } from '../core/policy';
import { installModuleHook, onModuleLoad } from './moduleHook';

/**
 * Observes `pg.Pool` construction.
 *
 * The pool is intercepted rather than inspected afterwards, because the
 * options object is merged into private state and the effective values are not
 * readable from the instance. Interception also gives the stack trace, which
 * is what turns "a pool has no timeout" into "src/db/index.ts:14 has no
 * timeout".
 */

/** pg's own defaults, from its documented Pool options. */
const POOL_SETTINGS: readonly SettingSpec[] = [
  { name: 'connectionTimeoutMillis', libraryDefault: 0 },
  { name: 'idleTimeoutMillis', libraryDefault: 10000 },
  { name: 'max', libraryDefault: 10 },
  { name: 'statement_timeout' },
  { name: 'query_timeout' },
  { name: 'allowExitOnIdle', libraryDefault: false },
];

let armed = false;

function observePool(
  options: unknown,
  filled: readonly string[],
  version: string | undefined,
  site: CallSite | undefined,
): void {
  const settings = settingsFromOptions(options, POOL_SETTINGS);
  for (const name of filled) {
    const setting = settings[name];
    if (setting !== undefined) settings[name] = { ...setting, note: FILLED_NOTE };
  }

  record({
    id: nextObservationId('pg.Pool'),
    subsystem: 'pg',
    target: 'pg.Pool',
    library: 'pg',
    libraryVersion: version,
    settings,
    site,
    observedAt: Date.now(),
  });
}

/**
 * Merges safe values into the options before the pool exists.
 *
 * A pool's effective settings are copied into private state in the
 * constructor, so this is the only moment they can be influenced. Keys the
 * caller supplied are left exactly as they are, including a deliberate
 * `connectionTimeoutMillis: 0`, because the developer meant it.
 */
function applyPolicyToOptions(options: unknown): { options: unknown; filled: string[] } {
  const filled: string[] = [];
  let next = options;

  for (const spec of POOL_SETTINGS) {
    const planned = plannedValue('pg', spec.name);
    if (planned === undefined) continue;
    if (isRecord(next) && next[spec.name] !== undefined) continue;

    const enforcing = policyMode() === 'enforce';
    if (enforcing) {
      next = isRecord(next) ? { ...next } : {};
      (next as Record<string, unknown>)[spec.name] = planned.value;
      filled.push(spec.name);
    }
    recordChange({
      subsystem: 'pg',
      target: 'pg.Pool',
      setting: spec.name,
      from: 'unset',
      to: planned.value,
      ruleId: planned.ruleId,
      applied: enforcing,
    });
  }
  return { options: next, filled };
}

/**
 * Wraps the exported `Pool` with a construct trap.
 *
 * A Proxy is used rather than a subclass so that `instanceof`, static
 * properties and the prototype chain are all untouched. Code doing
 * `pool instanceof pg.Pool` keeps working, which a subclass would break in one
 * direction and a plain function would break in both.
 */
export function wrapPgExports(exports: unknown, version: string | undefined): unknown {
  if (!isRecord(exports)) return exports;
  const Pool = exports['Pool'];
  if (typeof Pool !== 'function') return exports;

  // A named function declaration, not a shorthand method, because the call
  // site is recovered by handing this exact function to
  // `Error.captureStackTrace`. A Proxy object never appears as a stack frame,
  // so passing the proxy itself silently reported this file instead.
  function construct(target: object, args: unknown[], newTarget: unknown): object {
    let effective = args;
    let filled: string[] = [];
    try {
      const planned = applyPolicyToOptions(args[0]);
      filled = planned.filled;
      if (filled.length > 0) effective = [planned.options, ...args.slice(1)];
    } catch {
      // If the policy cannot be applied, construct exactly what was asked
      // for. A pool that exists with bad defaults beats one that throws.
      effective = args;
      filled = [];
    }

    const site = captureCallSite(construct);
    const instance = Reflect.construct(
      target as new (...a: unknown[]) => unknown,
      effective,
      newTarget as new (...a: unknown[]) => unknown,
    );
    try {
      observePool(effective[0], filled, version, site);
    } catch {
      // Never let observation stop a pool from being created.
    }
    return instance as object;
  }

  const proxied = new Proxy(Pool as new (...args: unknown[]) => unknown, { construct });

  try {
    Object.defineProperty(exports, 'Pool', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: proxied,
    });
  } catch {
    return exports;
  }
  return exports;
}

export function installPgObserver(): void {
  if (armed) return;
  armed = true;
  installModuleHook();
  onModuleLoad('pg', wrapPgExports);
  arm('pg');
}

export function isPgObserverArmed(): boolean {
  return armed;
}

/** Test-only. */
export function resetPgObserver(): void {
  armed = false;
}
