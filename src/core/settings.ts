import type { ObservedSetting } from '../types/index';

/**
 * Helpers for turning a library's options object into observed settings.
 *
 * The rule the whole package rests on is applied here: **presence of the key
 * decides, not the value**. `new Pool({ idleTimeoutMillis: 10_000 })` is the
 * library default, and it is still an explicit choice, because the developer
 * typed it. Inferring intent from the value would make `applySafeDefaults()`
 * overwrite deliberate configuration, which is the one thing it must never do.
 */

/** What a setting is called, and what the library does when left alone. */
export interface SettingSpec {
  readonly name: string;
  readonly libraryDefault?: unknown;
  /** Set when the value genuinely cannot be read from outside the library. */
  readonly unreadable?: string;
}

export function explicit(value: unknown, libraryDefault?: unknown): ObservedSetting {
  return libraryDefault === undefined
    ? { state: 'explicit', value }
    : { state: 'explicit', value, libraryDefault };
}

export function unset(libraryDefault?: unknown): ObservedSetting {
  return libraryDefault === undefined
    ? { state: 'unset' }
    : { state: 'unset', value: libraryDefault, libraryDefault };
}

/**
 * "Could not determine" and "nothing wrong" must never look the same, so this
 * carries a note explaining why the value is out of reach.
 */
export function unknown(note: string): ObservedSetting {
  return { state: 'unknown', note };
}

/**
 * Reads a plain options object against a spec list.
 *
 * `undefined` is treated as absent, matching how every library in scope
 * handles it: passing `{ idleTimeoutMillis: undefined }` gets you the default,
 * so calling it explicit would be a lie.
 */
export function settingsFromOptions(
  options: unknown,
  specs: readonly SettingSpec[],
): Record<string, ObservedSetting> {
  const source = isRecord(options) ? options : {};
  const out: Record<string, ObservedSetting> = {};

  for (const spec of specs) {
    if (spec.unreadable !== undefined && !(spec.name in source)) {
      out[spec.name] = unknown(spec.unreadable);
      continue;
    }
    const present = spec.name in source && source[spec.name] !== undefined;
    out[spec.name] = present
      ? explicit(source[spec.name], spec.libraryDefault)
      : unset(spec.libraryDefault);
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
