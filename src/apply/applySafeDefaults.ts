import type {
  ApplyOptions,
  ApplyResult,
  Profile,
  Rule,
  Subsystem,
} from '../types/index';
import { builtinRules, mergeRules, resolveForProfile } from '../rules/index';
import { configurePolicy, recordedChanges } from '../core/policy';
import { installObservers } from '../observers/index';
import { resolveProfile } from '../core/profile';

/**
 * Fills in safe values for settings nobody configured.
 *
 * Deliberately **not** called `harden()`. SES defines a global `harden()` for
 * deep-freezing objects, used by LavaMoat and Agoric. That is the same
 * neighbourhood and a different meaning, and a name collision in the boot path
 * of a production service is not a good place to be clever.
 *
 * Defaults to `report` mode, which computes and logs exactly what it would do
 * and changes nothing. Nobody should put an unfamiliar library in the boot
 * path of a production service in enforce mode on day one, and a tool that
 * requires them to is a tool they will not adopt.
 *
 * ```ts
 * applySafeDefaults();                                   // see what it would do
 * applySafeDefaults({ mode: 'enforce', pg: true });       // then turn one on
 * ```
 *
 * Coverage note, stated rather than glossed: called as a function it reaches
 * globals like `fetch` and anything constructed afterwards. ESM imports are
 * hoisted and evaluated before this line runs, so a module the application
 * already destructured is out of reach. For full coverage use the preload:
 *
 * ```
 * node --import @gagandeep023/production-audit/register app.js
 * ```
 */
export function applySafeDefaults(options: ApplyOptions = {}): ApplyResult {
  const mode = options.mode ?? 'report';
  const profile = resolveProfile(options.profile);
  const subsystems = selectSubsystems(options);

  const rules = mergeRules(builtinRules());
  const { values, ruleIds } = planValues(rules, profile, subsystems);

  // Overrides win over the corpus. Keys are `subsystem.setting`, the same
  // shape the rules resolve to, so a team can retune one number without
  // forking a rule.
  for (const [key, value] of Object.entries(options.values ?? {})) {
    values.set(key, value);
    if (!ruleIds.has(key)) ruleIds.set(key, 'config.values');
  }

  configurePolicy({
    mode,
    subsystems,
    values,
    rules: ruleIds,
    log: options.log ?? true,
    logger: options.logger,
  });

  // Observers are installed for exactly the subsystems opted into. All of
  // them start record-only; the policy above is what lets them write.
  installObservers({
    fetch: subsystems.includes('fetch'),
    http: subsystems.includes('http'),
    pg: subsystems.includes('pg'),
  });

  return {
    mode,
    profile,
    changes: recordedChanges(),
    subsystems,
  };
}

/**
 * All-or-nothing opt-in means people either take risks they did not evaluate
 * or skip the feature, so an explicit toggle list is honoured exactly, and an
 * empty list means all of them.
 */
function selectSubsystems(options: ApplyOptions): Subsystem[] {
  const explicitlySet =
    options.fetch !== undefined || options.http !== undefined || options.pg !== undefined;

  if (!explicitlySet) return ['fetch', 'http', 'pg'];

  const selected: Subsystem[] = [];
  if (options.fetch) selected.push('fetch');
  if (options.http) selected.push('http');
  if (options.pg) selected.push('pg');
  return selected;
}

/**
 * Turns the corpus into a flat `subsystem.setting` -> value map.
 *
 * A rule only contributes a value if it declares one, so a check with no
 * agreed safe answer stays a report-only check rather than guessing.
 */
function planValues(
  rules: readonly Rule[],
  profile: Profile,
  subsystems: readonly Subsystem[],
): { values: Map<string, unknown>; ruleIds: Map<string, string> } {
  const values = new Map<string, unknown>();
  const ruleIds = new Map<string, string>();
  const wanted = new Set(subsystems);

  for (const rule of rules) {
    const resolved = resolveForProfile(rule, profile);
    if (resolved === null) continue;

    const subsystem = subsystemOf(rule);
    if (subsystem === undefined || !wanted.has(subsystem)) continue;

    for (const [setting, value] of Object.entries(resolved.safeDefaults)) {
      const key = `${subsystem}.${setting}`;
      values.set(key, value);
      ruleIds.set(key, rule.id);
    }
  }
  return { values, ruleIds };
}

/** Maps a rule onto the observer that can act on it. */
function subsystemOf(rule: Rule): Subsystem | undefined {
  if (rule.target === 'globalThis.fetch') return 'fetch';
  if (rule.target === 'http.Server') return 'http';
  if (rule.target === 'pg.Pool') return 'pg';
  if (rule.library === 'pg') return 'pg';
  if (rule.library === 'node') return 'http';
  return undefined;
}
