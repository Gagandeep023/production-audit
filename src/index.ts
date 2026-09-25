import type {
  AuditConfig,
  EffectiveConfig,
  Finding,
  Profile,
  SubsystemToggles,
} from './types/index';
import { builtinRules, mergeRules } from './rules/index';
import { evaluate } from './core/evaluate';
import { snapshot } from './core/registry';
import { resolveProfile } from './core/profile';
import { installObservers } from './observers/index';
import { formatReport, supportsColor } from './report/format';
import { toJsonReport } from './report/json';
import type { JsonReport } from './report/json';

export { VERSION } from './version';

/**
 * @gagandeep023/production-audit
 *
 * Node libraries ship defaults that can never be fixed. `fetch()` waits
 * forever; a `pg` pool queues forever; an HTTP server closes keep-alive
 * sockets five seconds before the load balancer in front of it expects. None
 * of that can be changed at the source, because making `fetch()` time out by
 * default would break every existing user, so the gap does not expire the way
 * most tooling gaps do.
 *
 * A static linter cannot find these, because the effective value does not
 * exist until environment variables, config merging and the installed version
 * have all had their say, and because the worst findings are relationships
 * between two numbers, one of which is not in your codebase at all.
 *
 * So this runs inside the booted application and reports what the objects
 * actually are.
 *
 * ```ts
 * import { observe, audit } from '@gagandeep023/production-audit';
 *
 * observe();                       // record only, changes nothing
 * // ... boot the app, take some traffic ...
 * console.log(audit().report);
 * ```
 */

/**
 * Installs the observers. Nothing here modifies behaviour: the fetch wrapper
 * passes `init` straight through, the server accessors return the real value,
 * and the pool proxy constructs exactly what was asked for.
 *
 * That is why the audit half ships first. It is safe to put in the boot path
 * of a production service before anything is allowed to change a running
 * system, and it proves the rules are right before they are trusted to act.
 */
export function observe(toggles?: SubsystemToggles): void {
  installObservers(toggles);
}

export interface AuditResult {
  readonly config: EffectiveConfig;
  readonly findings: readonly Finding[];
  /** Human-readable, with the location and the lines to add. */
  readonly report: string;
  readonly json: JsonReport;
  /** Worst severity seen, for a CI gate. Null when there are no findings. */
  readonly worst: Finding['severity'] | null;
}

/**
 * Evaluates everything observed so far.
 *
 * Call it whenever you like: after boot, after the first request, from a
 * `/debug` route. Later is usually better, because a pool constructed lazily
 * on the first query does not exist at boot.
 */
export function audit(config: AuditConfig = {}): AuditResult {
  const profile: Profile = resolveProfile(config.profile);
  const effective = snapshot(profile);
  const rules = mergeRules(builtinRules(), config.rules, config.disableRules);

  const findings = evaluate(effective, {
    rules,
    suppressions: config.suppressions,
    minSeverity: config.minSeverity,
  });

  return {
    config: effective,
    findings,
    report: formatReport(effective, findings, { color: supportsColor() }),
    json: toJsonReport(effective, findings),
    worst: findings[0]?.severity ?? null,
  };
}

export { applySafeDefaults } from './apply/applySafeDefaults';
export { builtinRules, mergeRules, validateRule, validateRules, parseRules } from './rules/index';
export { evaluate } from './core/evaluate';
export { formatFinding, formatReport, formatSummary } from './report/format';
export { toJsonReport } from './report/json';
export { observedOrigins, observedRequestCount } from './observers/index';
export { DEFAULT_PROFILE, resolveProfile } from './core/profile';
export { SEVERITY_ORDER, severityRank, PROFILES } from './types/index';
export type * from './types/index';
export type { JsonReport, JsonFinding, JsonObservation } from './report/json';
export type { AuditResult as AuditReport };
