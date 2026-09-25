/**
 * Public type surface for @gagandeep023/production-audit.
 *
 * The package answers one question: what is the *effective* configuration of
 * this running process, and which parts of it are known to cause outages?
 * Every type here exists to keep three things apart that are easy to conflate:
 *
 *   - a value the developer chose         -> `explicit`, never touched by us
 *   - a value nobody chose                -> `unset`,    the library default applies
 *   - a value we could not determine      -> `unknown`,  reported as unknown, never as fine
 */

export const TYPES_VERSION = '0.1.0';

/* ------------------------------------------------------------------ *
 * Severity and profiles
 * ------------------------------------------------------------------ */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Ordered worst-first, so reports and exit codes can compare severities. */
export const SEVERITY_ORDER: readonly Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export function severityRank(severity: Severity): number {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/**
 * What kind of process this is. One timeout number is wrong for a batch worker
 * and a payment path, so rules are gated and re-valued per profile rather than
 * firing a wall of findings that get muted.
 */
export type Profile = 'http-api' | 'worker' | 'cli';

export const PROFILES: readonly Profile[] = ['http-api', 'worker', 'cli'];

/** The part of the stack an observation or rule belongs to. */
export type Subsystem = 'fetch' | 'undici' | 'http' | 'pg' | (string & {});

/* ------------------------------------------------------------------ *
 * Observations: what the running process actually looks like
 * ------------------------------------------------------------------ */

/**
 * Tri-state, and the distinction the whole package rests on.
 *
 * `explicit` is decided by *assignment*, never by value. `keepAliveTimeout`
 * defaults to 5000, so `server.keepAliveTimeout = 5000` is indistinguishable
 * by value from untouched. Presence of a constructor option key counts as
 * explicit even when its value equals the library default.
 */
export type SettingState = 'explicit' | 'unset' | 'unknown';

export interface ObservedSetting {
  readonly state: SettingState;
  /** The effective value. Absent when `state` is `unknown`. */
  readonly value?: unknown;
  /**
   * What the library does when the setting is left alone. Present on `unset`
   * settings so a report can say what will actually happen, not just that
   * nothing was configured.
   */
  readonly libraryDefault?: unknown;
  /** Human-readable note, used mainly to explain why something is unknown. */
  readonly note?: string;
}

/** Where in the user's code an object was constructed. */
export interface CallSite {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  /** The formatted frame, kept for reports that want the original text. */
  readonly frame: string;
}

/**
 * One observed configurable thing: a pool, a server, the global fetch, a
 * dispatcher. Produced by observers, consumed by the evaluator, and never
 * mutated after it is recorded.
 */
export interface Observation {
  /** Stable within a process. Used to dedupe and to attach findings. */
  readonly id: string;
  readonly subsystem: Subsystem;
  /** What was observed, e.g. `pg.Pool`, `http.Server`, `globalThis.fetch`. */
  readonly target: string;
  /** npm package the target comes from, matched against `Rule.library`. */
  readonly library: string;
  /** Installed version, when it could be resolved. Drives `versionRange`. */
  readonly libraryVersion?: string;
  readonly settings: Readonly<Record<string, ObservedSetting>>;
  /** Where the user constructed it. Absent for globals and for late attaches. */
  readonly site?: CallSite;
  /** How many times this object was exercised, when the observer can count. */
  readonly uses?: number;
  readonly observedAt: number;
}

/** The whole picture at the moment a report is produced. */
export interface EffectiveConfig {
  readonly observations: readonly Observation[];
  readonly profile: Profile;
  readonly nodeVersion: string;
  readonly collectedAt: number;
  /**
   * Subsystems an observer was installed for. A subsystem that is armed but
   * produced no observation means "nothing was constructed", which is
   * different from "we were not looking".
   */
  readonly armed: readonly Subsystem[];
}

/* ------------------------------------------------------------------ *
 * Rules: data, not code
 * ------------------------------------------------------------------ */

/**
 * The condition under which a setting is dangerous. Deliberately a small
 * closed set: rules ship as JSON and must be contributable by people who will
 * never read this file.
 */
export type Condition =
  | { readonly kind: 'unset' }
  | { readonly kind: 'equals'; readonly value: unknown }
  | { readonly kind: 'lessThan'; readonly value: number }
  | { readonly kind: 'greaterThan'; readonly value: number }
  /** Unset, or set to a value that means "no limit". The pool case. */
  | { readonly kind: 'unsetOr'; readonly value: unknown }
  /**
   * A relationship between two observed settings. This is the class a static
   * linter cannot reach, and one side may not be in the codebase at all.
   */
  | { readonly kind: 'lessThanSetting'; readonly setting: string };

/** Shorthand accepted in JSON: `"dangerousWhen": "unset"`. */
export type ConditionInput = Condition | 'unset';

export interface FixSnippet {
  /** Lines shown unchanged, for context. */
  readonly context?: readonly string[];
  /** Lines shown as additions in the diff-style output. */
  readonly added: readonly string[];
}

export interface Rule {
  /** `library/what-is-wrong`, e.g. `undici/fetch-no-timeout`. */
  readonly id: string;
  readonly library: string;
  /** Restricts the rule to one target, e.g. `pg.Pool`. Optional. */
  readonly target?: string;
  /** Semver range against `Observation.libraryVersion`, e.g. `>=5`. */
  readonly versionRange?: string;
  /** Settings the condition is tested against. */
  readonly settings: readonly string[];
  /**
   * `any` fires when any listed setting is dangerous. `all` fires only when
   * every one of them is, which is how "no timeout of any kind" is expressed.
   */
  readonly match?: 'any' | 'all';
  readonly dangerousWhen: ConditionInput;
  readonly severity: Severity;
  readonly why: string;
  readonly fix: string;
  readonly fixSnippet?: FixSnippet;
  /** Link to a public postmortem. The point of the corpus. */
  readonly incident?: string;
  /** Profiles the rule applies to. Absent means all of them. */
  readonly profiles?: readonly Profile[];
  /** Values `applySafeDefaults()` writes for the settings this rule covers. */
  readonly safeDefaults?: Readonly<Record<string, unknown>>;
  /**
   * Per-profile overrides. A `null` entry disables the rule for that profile,
   * which is how a rule that is right for an API is kept off a CLI.
   */
  readonly profileOverrides?: Readonly<
    Record<string, Readonly<Record<string, unknown>> | null>
  >;
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

/**
 * `dangerous` means the rule matched. `unknown` means the rule applied but the
 * effective value could not be read, which is reported rather than passed.
 * `suppressed-expired` is a suppression whose expiry has passed.
 */
export type FindingKind = 'dangerous' | 'unknown' | 'suppressed-expired';

export interface FindingSetting {
  readonly name: string;
  readonly state: SettingState;
  readonly value?: unknown;
  readonly libraryDefault?: unknown;
}

export interface Finding {
  readonly ruleId: string;
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly subsystem: Subsystem;
  readonly target: string;
  readonly library: string;
  readonly libraryVersion?: string;
  readonly observationId: string;
  readonly settings: readonly FindingSetting[];
  readonly why: string;
  readonly fix: string;
  readonly fixSnippet?: FixSnippet;
  readonly incident?: string;
  readonly site?: CallSite;
}

/* ------------------------------------------------------------------ *
 * Suppressions and configuration
 * ------------------------------------------------------------------ */

/**
 * A suppression must say why and must expire. Without both, the list becomes a
 * graveyard nobody revisits, so an expired entry turns back into a finding.
 */
export interface Suppression {
  readonly ruleId: string;
  readonly reason: string;
  /** ISO 8601 date. Past dates produce a `suppressed-expired` finding. */
  readonly expires: string;
  /** Optional narrowing, matched against `Observation.target`. */
  readonly target?: string;
}

export interface AuditConfig {
  readonly profile?: Profile;
  /** Appended to the built-in corpus. Later rules with the same id win. */
  readonly rules?: readonly Rule[];
  /** Rule ids to drop entirely, no reason or expiry required. */
  readonly disableRules?: readonly string[];
  readonly suppressions?: readonly Suppression[];
  /** Findings below this severity are dropped from the report. */
  readonly minSeverity?: Severity;
}

/* ------------------------------------------------------------------ *
 * applySafeDefaults
 * ------------------------------------------------------------------ */

export type ApplyMode = 'report' | 'enforce';

export interface SubsystemToggles {
  readonly fetch?: boolean;
  readonly http?: boolean;
  readonly pg?: boolean;
}

export interface ApplyOptions extends SubsystemToggles {
  /** Defaults to `report`. Nothing is modified until this is `enforce`. */
  readonly mode?: ApplyMode;
  readonly profile?: Profile;
  /** Values that win over the corpus, keyed `subsystem.setting`. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Set false to suppress the boot log. Off by default, deliberately loud. */
  readonly log?: boolean;
  readonly logger?: (message: string) => void;
}

/** One value `applySafeDefaults()` filled in, or would fill in. */
export interface AppliedChange {
  readonly subsystem: Subsystem;
  readonly target: string;
  readonly setting: string;
  readonly from: 'unset';
  readonly to: unknown;
  readonly ruleId: string;
  /** False in report mode. */
  readonly applied: boolean;
}

export interface ApplyResult {
  readonly mode: ApplyMode;
  readonly profile: Profile;
  readonly changes: readonly AppliedChange[];
  /** Subsystems that were switched on for this call. */
  readonly subsystems: readonly Subsystem[];
}
