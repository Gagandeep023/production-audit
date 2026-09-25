import type { AppliedChange, ApplyMode, Subsystem } from '../types/index';

/**
 * The shared policy `applySafeDefaults()` configures and the observers read.
 *
 * It lives in core rather than in `apply/` so the observers never import the
 * thing that configures them, and so an observer compiled into a process that
 * only ever audits has no path to modifying anything.
 *
 * Four constraints are enforced here and nowhere else, because a reliability
 * tool that causes an outage is worse than no tool:
 *
 *   1. Only unset values are filled. The observers own the `assigned` check.
 *   2. Every change is logged, loudly, by default.
 *   3. Subsystems are opted into individually.
 *   4. The mode is `report` until somebody asks for `enforce`.
 */

export const FILLED_NOTE = 'filled by production-audit';

interface PolicyState {
  mode: ApplyMode;
  enabled: Set<Subsystem>;
  /** `subsystem.setting` -> value. */
  values: Map<string, unknown>;
  /** `subsystem.setting` -> rule that supplied the value. */
  rules: Map<string, string>;
  log: boolean;
  logger: (message: string) => void;
  changes: AppliedChange[];
  configured: boolean;
}

const state: PolicyState = {
  mode: 'report',
  enabled: new Set(),
  values: new Map(),
  rules: new Map(),
  log: true,
  logger: (message) => process.stderr.write(`${message}\n`),
  changes: [],
  configured: false,
};

export interface PolicyInput {
  readonly mode: ApplyMode;
  readonly subsystems: readonly Subsystem[];
  readonly values: ReadonlyMap<string, unknown>;
  readonly rules: ReadonlyMap<string, string>;
  readonly log: boolean;
  readonly logger?: (message: string) => void;
}

export function configurePolicy(input: PolicyInput): void {
  state.mode = input.mode;
  state.enabled = new Set(input.subsystems);
  state.values = new Map(input.values);
  state.rules = new Map(input.rules);
  state.log = input.log;
  if (input.logger !== undefined) state.logger = input.logger;
  state.configured = true;
}

export function policyMode(): ApplyMode {
  return state.mode;
}

export function isPolicyConfigured(): boolean {
  return state.configured;
}

export function isSubsystemEnabled(subsystem: Subsystem): boolean {
  return state.configured && state.enabled.has(subsystem);
}

/** The value to fill for a setting, or undefined when no rule supplies one. */
export function plannedValue(
  subsystem: Subsystem,
  setting: string,
): { value: unknown; ruleId: string } | undefined {
  if (!isSubsystemEnabled(subsystem)) return undefined;
  const key = `${subsystem}.${setting}`;
  if (!state.values.has(key)) return undefined;
  return { value: state.values.get(key), ruleId: state.rules.get(key) ?? 'unknown' };
}

/**
 * Records a change and, unless silenced, says so.
 *
 * Silent behaviour modification is how a helpful library becomes a three-hour
 * debugging session six months later, so the log is on by default and names
 * the rule that caused it.
 */
export function recordChange(change: AppliedChange): void {
  state.changes.push(change);
  if (!state.log) return;
  const verb = change.applied ? 'set' : 'would set';
  state.logger(
    `production-audit: ${verb} ${change.target} ${change.setting} = ${String(change.to)} (was unset) [${change.ruleId}]`,
  );
}

export function recordedChanges(): readonly AppliedChange[] {
  return state.changes;
}

/** Test-only. */
export function resetPolicy(): void {
  state.mode = 'report';
  state.enabled = new Set();
  state.values = new Map();
  state.rules = new Map();
  state.log = true;
  state.logger = (message) => process.stderr.write(`${message}\n`);
  state.changes = [];
  state.configured = false;
}
