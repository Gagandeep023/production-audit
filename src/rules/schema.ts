import { PROFILES, SEVERITY_ORDER } from '../types/index';
import type { Condition, ConditionInput, Profile, Rule, Severity } from '../types/index';
import { isRecord } from '../core/settings';

/**
 * Validation for contributed rules.
 *
 * Rules are data so that somebody can turn their postmortem into a check
 * without reading the source. That only works if a malformed rule fails
 * loudly in CI instead of silently never matching, so every field is checked
 * and every error names the rule and the field.
 */

export interface ValidationError {
  readonly ruleId: string;
  readonly field: string;
  readonly message: string;
}

const CONDITION_KINDS = [
  'unset',
  'equals',
  'lessThan',
  'greaterThan',
  'unsetOr',
  'lessThanSetting',
] as const;

const ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Accepts the `"dangerousWhen": "unset"` shorthand rule authors actually write. */
export function normalizeCondition(input: ConditionInput): Condition {
  return input === 'unset' ? { kind: 'unset' } : input;
}

function validateCondition(
  raw: unknown,
  ruleId: string,
  errors: ValidationError[],
): void {
  const field = 'dangerousWhen';
  if (raw === 'unset') return;
  if (!isRecord(raw)) {
    errors.push({ ruleId, field, message: 'must be "unset" or a condition object' });
    return;
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(CONDITION_KINDS as readonly string[]).includes(kind)) {
    errors.push({
      ruleId,
      field: `${field}.kind`,
      message: `must be one of ${CONDITION_KINDS.join(', ')}`,
    });
    return;
  }
  if ((kind === 'lessThan' || kind === 'greaterThan') && typeof raw['value'] !== 'number') {
    errors.push({ ruleId, field: `${field}.value`, message: `${kind} requires a numeric value` });
  }
  if ((kind === 'equals' || kind === 'unsetOr') && !('value' in raw)) {
    errors.push({ ruleId, field: `${field}.value`, message: `${kind} requires a value` });
  }
  if (kind === 'lessThanSetting' && typeof raw['setting'] !== 'string') {
    errors.push({
      ruleId,
      field: `${field}.setting`,
      message: 'lessThanSetting requires the name of another setting',
    });
  }
}

export function validateRule(raw: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(raw)) {
    return [{ ruleId: '<unknown>', field: '<root>', message: 'rule must be an object' }];
  }

  const id = typeof raw['id'] === 'string' ? raw['id'] : '<unknown>';
  if (typeof raw['id'] !== 'string' || !ID_RE.test(raw['id'])) {
    errors.push({ ruleId: id, field: 'id', message: 'must look like "library/what-is-wrong"' });
  }

  for (const field of ['library', 'why', 'fix'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push({ ruleId: id, field, message: 'is required and must be a non-empty string' });
    }
  }

  const severity = raw['severity'];
  if (typeof severity !== 'string' || !SEVERITY_ORDER.includes(severity as Severity)) {
    errors.push({
      ruleId: id,
      field: 'severity',
      message: `must be one of ${SEVERITY_ORDER.join(', ')}`,
    });
  }

  const settings = raw['settings'];
  if (
    !Array.isArray(settings) ||
    settings.length === 0 ||
    settings.some((s) => typeof s !== 'string')
  ) {
    errors.push({ ruleId: id, field: 'settings', message: 'must be a non-empty array of names' });
  }

  const match = raw['match'];
  if (match !== undefined && match !== 'any' && match !== 'all') {
    errors.push({ ruleId: id, field: 'match', message: 'must be "any" or "all"' });
  }

  validateCondition(raw['dangerousWhen'], id, errors);

  const profiles = raw['profiles'];
  if (profiles !== undefined) {
    if (!Array.isArray(profiles)) {
      errors.push({ ruleId: id, field: 'profiles', message: 'must be an array' });
    } else {
      for (const profile of profiles) {
        if (!PROFILES.includes(profile as Profile)) {
          errors.push({
            ruleId: id,
            field: 'profiles',
            message: `unknown profile "${String(profile)}"`,
          });
        }
      }
    }
  }

  const overrides = raw['profileOverrides'];
  if (overrides !== undefined) {
    if (!isRecord(overrides)) {
      errors.push({ ruleId: id, field: 'profileOverrides', message: 'must be an object' });
    } else {
      for (const key of Object.keys(overrides)) {
        if (!PROFILES.includes(key as Profile)) {
          errors.push({
            ruleId: id,
            field: `profileOverrides.${key}`,
            message: 'unknown profile',
          });
        }
      }
    }
  }

  // A rule that fills a setting it does not check would apply a value nobody
  // asked about, so the two lists have to agree.
  const safeDefaults = raw['safeDefaults'];
  if (safeDefaults !== undefined) {
    if (!isRecord(safeDefaults)) {
      errors.push({ ruleId: id, field: 'safeDefaults', message: 'must be an object' });
    } else if (Array.isArray(settings)) {
      for (const key of Object.keys(safeDefaults)) {
        if (!settings.includes(key)) {
          errors.push({
            ruleId: id,
            field: `safeDefaults.${key}`,
            message: 'names a setting the rule does not list in `settings`',
          });
        }
      }
    }
  }

  const incident = raw['incident'];
  if (incident !== undefined && (typeof incident !== 'string' || !/^https?:\/\//.test(incident))) {
    errors.push({ ruleId: id, field: 'incident', message: 'must be an http(s) URL' });
  }

  return errors;
}

/** Validates a whole corpus and rejects duplicate ids, which silently shadow. */
export function validateRules(raw: readonly unknown[]): ValidationError[] {
  const errors = raw.flatMap((rule) => validateRule(rule));
  const seen = new Set<string>();
  for (const rule of raw) {
    if (!isRecord(rule) || typeof rule['id'] !== 'string') continue;
    if (seen.has(rule['id'])) {
      errors.push({ ruleId: rule['id'], field: 'id', message: 'duplicate rule id' });
    }
    seen.add(rule['id']);
  }
  return errors;
}

/** Throws on the first problem. Used when loading user-supplied rule files. */
export function parseRules(raw: readonly unknown[]): Rule[] {
  const errors = validateRules(raw);
  if (errors.length > 0) {
    const lines = errors.map((e) => `  ${e.ruleId}: ${e.field} ${e.message}`);
    throw new Error(`Invalid rules:\n${lines.join('\n')}`);
  }
  return raw as Rule[];
}
