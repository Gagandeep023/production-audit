import type {
  AuditConfig,
  Condition,
  EffectiveConfig,
  Finding,
  FindingSetting,
  Observation,
  ObservedSetting,
  Profile,
  Rule,
  Severity,
  Suppression,
} from '../types/index';
import { severityRank } from '../types/index';
import { normalizeCondition, resolveForProfile } from '../rules/index';
import { satisfies } from './semver';

/**
 * The evaluator: pure functions over observed configuration, no I/O.
 *
 * Everything that decides whether something is a finding lives here, so the
 * rules can be tested against hand-written observations without booting a
 * server or opening a socket.
 */

type Verdict = 'dangerous' | 'safe' | 'unknown';

function evaluateCondition(
  condition: Condition,
  setting: ObservedSetting | undefined,
  observation: Observation,
): Verdict {
  // Never observed at all. Saying "safe" here is exactly the failure this
  // package exists to find, so it is unknown.
  if (setting === undefined) return 'unknown';
  if (setting.state === 'unknown') return 'unknown';

  switch (condition.kind) {
    case 'unset':
      return setting.state === 'unset' ? 'dangerous' : 'safe';

    case 'unsetOr':
      if (setting.state === 'unset') return 'dangerous';
      return setting.value === condition.value ? 'dangerous' : 'safe';

    case 'equals':
      if (setting.value === undefined) return 'unknown';
      return setting.value === condition.value ? 'dangerous' : 'safe';

    case 'lessThan':
      if (typeof setting.value !== 'number') return 'unknown';
      return setting.value < condition.value ? 'dangerous' : 'safe';

    case 'greaterThan':
      if (typeof setting.value !== 'number') return 'unknown';
      return setting.value > condition.value ? 'dangerous' : 'safe';

    case 'lessThanSetting': {
      const other = observation.settings[condition.setting];
      if (other === undefined || other.state === 'unknown') return 'unknown';
      if (typeof setting.value !== 'number' || typeof other.value !== 'number') return 'unknown';
      return setting.value < other.value ? 'dangerous' : 'safe';
    }
  }
}

/**
 * `any` fires when one listed setting is dangerous. `all` fires only when
 * every one is, which is how "no timeout of any kind" is written.
 *
 * Unknown never becomes safe: if the verdict would otherwise be safe but a
 * setting could not be read, the result is unknown and the report says so.
 */
function combine(verdicts: readonly Verdict[], match: 'any' | 'all'): Verdict {
  if (verdicts.length === 0) return 'unknown';
  const dangerous = verdicts.filter((v) => v === 'dangerous').length;
  const unknown = verdicts.filter((v) => v === 'unknown').length;

  if (match === 'any') {
    if (dangerous > 0) return 'dangerous';
    return unknown > 0 ? 'unknown' : 'safe';
  }
  if (dangerous === verdicts.length) return 'dangerous';
  return dangerous + unknown === verdicts.length ? 'unknown' : 'safe';
}

function appliesTo(rule: Rule, observation: Observation): boolean {
  if (rule.library !== observation.library) return false;
  if (rule.target !== undefined && rule.target !== observation.target) return false;

  if (rule.versionRange !== undefined) {
    // A version-scoped rule on a library whose version could not be resolved
    // is left inert. Firing would be a guess, and a guessed finding on a rule
    // the user cannot verify is how a tool earns a permanent mute.
    if (observation.libraryVersion === undefined) return false;
    if (!satisfies(observation.libraryVersion, rule.versionRange)) return false;
  }
  return true;
}

function toFindingSettings(rule: Rule, observation: Observation): FindingSetting[] {
  return rule.settings.map((name) => {
    const setting = observation.settings[name];
    return {
      name,
      state: setting?.state ?? 'unknown',
      value: setting?.value,
      libraryDefault: setting?.libraryDefault,
    };
  });
}

function isExpired(suppression: Suppression, now: number): boolean {
  const expires = Date.parse(suppression.expires);
  // An unparseable expiry is treated as expired. A suppression that cannot be
  // checked must not silence anything.
  if (Number.isNaN(expires)) return true;
  return expires <= now;
}

function matchingSuppression(
  suppressions: readonly Suppression[],
  rule: Rule,
  observation: Observation,
): Suppression | undefined {
  return suppressions.find(
    (s) =>
      s.ruleId === rule.id && (s.target === undefined || s.target === observation.target),
  );
}

export interface EvaluateOptions {
  readonly rules: readonly Rule[];
  readonly suppressions?: readonly Suppression[];
  readonly minSeverity?: Severity;
  /** Injected so suppression expiry is testable without touching the clock. */
  readonly now?: number;
}

export function evaluate(config: EffectiveConfig, options: EvaluateOptions): Finding[] {
  const now = options.now ?? Date.now();
  const suppressions = options.suppressions ?? [];
  const profile: Profile = config.profile;
  const findings: Finding[] = [];
  const usedSuppressions = new Set<Suppression>();

  for (const observation of config.observations) {
    for (const rule of options.rules) {
      if (!appliesTo(rule, observation)) continue;

      const resolved = resolveForProfile(rule, profile);
      if (resolved === null) continue;

      const condition = normalizeCondition(rule.dangerousWhen);
      const verdicts = rule.settings.map((name) =>
        evaluateCondition(condition, observation.settings[name], observation),
      );
      const verdict = combine(verdicts, rule.match ?? 'any');
      if (verdict === 'safe') continue;

      const suppression = matchingSuppression(suppressions, rule, observation);
      if (suppression !== undefined) {
        usedSuppressions.add(suppression);
        if (!isExpired(suppression, now)) continue;
      }

      findings.push({
        ruleId: rule.id,
        kind: suppression !== undefined ? 'suppressed-expired' : verdict,
        severity: rule.severity,
        subsystem: observation.subsystem,
        target: observation.target,
        library: observation.library,
        libraryVersion: observation.libraryVersion,
        observationId: observation.id,
        settings: toFindingSettings(rule, observation),
        why: rule.why,
        fix: rule.fix,
        fixSnippet: rule.fixSnippet,
        incident: rule.incident,
        site: observation.site,
      });
    }
  }

  // An expired suppression for a rule that no longer fires is dead config.
  // Reported at info so the list stays a list and not a graveyard.
  for (const suppression of suppressions) {
    if (usedSuppressions.has(suppression)) continue;
    if (!isExpired(suppression, now)) continue;
    findings.push({
      ruleId: 'audit/suppression-stale',
      kind: 'suppressed-expired',
      severity: 'info',
      subsystem: 'audit',
      target: 'suppressions',
      library: 'production-audit',
      observationId: 'config',
      settings: [{ name: suppression.ruleId, state: 'explicit', value: suppression.expires }],
      why: `The suppression for ${suppression.ruleId} expired on ${suppression.expires} and the rule no longer fires. Reason given: ${suppression.reason}`,
      fix: `Delete the suppression for ${suppression.ruleId}.`,
    });
  }

  const floor = options.minSeverity === undefined ? undefined : severityRank(options.minSeverity);
  const filtered =
    floor === undefined ? findings : findings.filter((f) => severityRank(f.severity) <= floor);

  return filtered.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.ruleId.localeCompare(b.ruleId);
  });
}

/** Convenience wrapper for the shape `AuditConfig` arrives in. */
export function evaluateWithConfig(
  config: EffectiveConfig,
  rules: readonly Rule[],
  auditConfig: AuditConfig = {},
  now?: number,
): Finding[] {
  return evaluate(config, {
    rules,
    suppressions: auditConfig.suppressions,
    minSeverity: auditConfig.minSeverity,
    now,
  });
}
