import type { EffectiveConfig, Observation, Profile, Subsystem } from '../types/index';

/**
 * Process-wide store of what the observers saw.
 *
 * Deliberately a module-level singleton. Observers install into globals and
 * module exports, so there is exactly one of them per process whatever the
 * consumer does, and threading a handle through a loader hook that runs before
 * the application's first import is not possible.
 */

let observations: Observation[] = [];
const armed = new Set<Subsystem>();
let counter = 0;

/** Ids only need to be unique within the process, so a counter is enough. */
export function nextObservationId(prefix: string): string {
  counter += 1;
  return `${prefix}#${counter}`;
}

export function record(observation: Observation): Observation {
  observations.push(observation);
  return observation;
}

/**
 * Replaces an observation in place, keeping its position in the list.
 *
 * Needed because an HTTP server's timeouts are assigned *after* construction:
 * the observation is recorded when the server is created and updated when
 * `server.keepAliveTimeout = ...` runs, or does not.
 */
export function update(id: string, next: Observation): void {
  const index = observations.findIndex((o) => o.id === id);
  if (index === -1) observations.push(next);
  else observations[index] = next;
}

export function find(id: string): Observation | undefined {
  return observations.find((o) => o.id === id);
}

export function list(): readonly Observation[] {
  return observations;
}

/**
 * Marks a subsystem as watched. A subsystem that is armed and produced nothing
 * means the application never constructed one, which is a different statement
 * from "we were not looking", and the report says so.
 */
export function arm(subsystem: Subsystem): void {
  armed.add(subsystem);
}

export function isArmed(subsystem: Subsystem): boolean {
  return armed.has(subsystem);
}

export function armedSubsystems(): readonly Subsystem[] {
  return [...armed];
}

export function snapshot(profile: Profile): EffectiveConfig {
  return {
    observations: [...observations],
    profile,
    nodeVersion: process.version,
    collectedAt: Date.now(),
    armed: [...armed],
  };
}

/** Test-only. Observers keep their own installed flags and reset separately. */
export function reset(): void {
  observations = [];
  armed.clear();
  counter = 0;
}
