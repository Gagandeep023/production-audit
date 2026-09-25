import type { Profile, Rule } from '../types/index';
import { parseRules, validateRules, validateRule, normalizeCondition } from './schema';
import httpRules from './corpus/http.json';
import pgRules from './corpus/pg.json';
import undiciRules from './corpus/undici.json';

export const RULES_VERSION = '0.1.0';

export { validateRule, validateRules, parseRules, normalizeCondition };
export type { ValidationError } from './schema';

/**
 * The built-in corpus.
 *
 * One JSON file per library, so contributing a check means adding a record to
 * a file and nothing else. The corpus is validated by its own test, which is
 * what keeps a malformed contribution from landing as a rule that quietly
 * never matches.
 */
const CORPUS: readonly unknown[] = [...undiciRules, ...httpRules, ...pgRules];

export function builtinRules(): Rule[] {
  return parseRules(CORPUS);
}

/**
 * Merges user rules over the built-ins. A user rule with the same id replaces
 * the built-in rather than adding a second one, which is how a team retunes a
 * check instead of suppressing it.
 */
export function mergeRules(
  base: readonly Rule[],
  extra: readonly Rule[] = [],
  disabled: readonly string[] = [],
): Rule[] {
  const byId = new Map<string, Rule>();
  for (const rule of base) byId.set(rule.id, rule);
  for (const rule of extra) byId.set(rule.id, rule);
  for (const id of disabled) byId.delete(id);
  return [...byId.values()];
}

/**
 * Whether a rule applies to a profile, and with which values.
 *
 * Returns `null` when the profile disables the rule. `safeDefaults` is merged
 * rather than replaced, so an override only has to restate the values it
 * actually changes.
 */
export function resolveForProfile(
  rule: Rule,
  profile: Profile,
): { rule: Rule; safeDefaults: Record<string, unknown> } | null {
  if (rule.profiles !== undefined && !rule.profiles.includes(profile)) return null;

  const override = rule.profileOverrides?.[profile];
  if (override === null) return null;

  return {
    rule,
    safeDefaults: { ...(rule.safeDefaults ?? {}), ...(override ?? {}) },
  };
}
