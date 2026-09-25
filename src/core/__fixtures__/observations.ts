import type { EffectiveConfig, Observation, ObservedSetting, Profile } from '../../types/index';
import { explicit, unknown, unset } from '../settings';

/**
 * Hand-built observations, so the rules can be tested without booting a
 * server, opening a socket or installing a driver. The evaluator is pure by
 * design precisely so this is possible.
 */

export { explicit, unset, unknown };

export function observation(
  overrides: Partial<Observation> & Pick<Observation, 'target' | 'library'>,
): Observation {
  return {
    id: overrides.id ?? `${overrides.target}#1`,
    subsystem: overrides.subsystem ?? 'test',
    settings: overrides.settings ?? {},
    observedAt: overrides.observedAt ?? 0,
    ...overrides,
  };
}

export function effective(
  observations: readonly Observation[],
  profile: Profile = 'http-api',
): EffectiveConfig {
  return {
    observations,
    profile,
    nodeVersion: 'v22.0.0',
    collectedAt: 0,
    armed: ['fetch', 'http', 'pg'],
  };
}

/** A pool where every dangerous setting was chosen on purpose. */
export function configuredPool(settings?: Record<string, ObservedSetting>): Observation {
  return observation({
    id: 'pg.Pool#1',
    subsystem: 'pg',
    target: 'pg.Pool',
    library: 'pg',
    libraryVersion: '8.13.1',
    settings: settings ?? {
      connectionTimeoutMillis: explicit(5000, 0),
      idleTimeoutMillis: explicit(30000, 10000),
      max: explicit(20, 10),
      statement_timeout: explicit(30000),
      query_timeout: explicit(30000),
      allowExitOnIdle: explicit(false, false),
    },
  });
}

/** The same pool as `new Pool({ connectionString })`. */
export function defaultPool(): Observation {
  return observation({
    id: 'pg.Pool#2',
    subsystem: 'pg',
    target: 'pg.Pool',
    library: 'pg',
    libraryVersion: '8.13.1',
    site: { file: '/app/src/db/index.ts', line: 14, column: 18, frame: 'at /app/src/db/index.ts:14:18' },
    settings: {
      connectionTimeoutMillis: unset(0),
      idleTimeoutMillis: unset(10000),
      max: unset(10),
      statement_timeout: unset(),
      query_timeout: unset(),
      allowExitOnIdle: unset(false),
    },
  });
}

export function configuredServer(): Observation {
  return observation({
    id: 'http#1',
    subsystem: 'http',
    target: 'http.Server',
    library: 'node',
    libraryVersion: '22.0.0',
    settings: {
      keepAliveTimeout: explicit(65000, 5000),
      headersTimeout: explicit(66000, 60000),
      requestTimeout: explicit(30000, 300000),
      timeout: explicit(0, 0),
    },
  });
}

export function defaultServer(): Observation {
  return observation({
    id: 'http#2',
    subsystem: 'http',
    target: 'http.Server',
    library: 'node',
    libraryVersion: '22.0.0',
    settings: {
      keepAliveTimeout: unset(5000),
      headersTimeout: unset(60000),
      requestTimeout: unset(300000),
      timeout: unset(0),
    },
  });
}

export function fetchSite(signal: ObservedSetting): Observation {
  return observation({
    id: 'fetch#1',
    subsystem: 'fetch',
    target: 'globalThis.fetch',
    library: 'undici',
    settings: { signal },
  });
}
