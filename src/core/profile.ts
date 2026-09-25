import { PROFILES } from '../types/index';
import type { Profile } from '../types/index';

/**
 * A single timeout number is right for a payment path and wrong for a batch
 * worker. Without profiles the tool produces a wall of findings that are
 * correct in general and wrong here, and a tool like that gets muted once and
 * never looked at again.
 */

export const DEFAULT_PROFILE: Profile = 'http-api';

export function isProfile(value: unknown): value is Profile {
  return typeof value === 'string' && PROFILES.includes(value as Profile);
}

/**
 * Explicit argument, then `PRODUCTION_AUDIT_PROFILE`, then `http-api`.
 *
 * The environment variable matters because the same image usually ships as
 * both an API and a worker, and the difference is a start command rather than
 * a code change.
 */
export function resolveProfile(explicitProfile?: Profile): Profile {
  if (explicitProfile !== undefined) return explicitProfile;
  const fromEnv = process.env['PRODUCTION_AUDIT_PROFILE'];
  return isProfile(fromEnv) ? fromEnv : DEFAULT_PROFILE;
}
