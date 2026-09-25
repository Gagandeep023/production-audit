import http from 'node:http';
import https from 'node:https';
import type { Server } from 'node:http';
import type { CallSite, Observation, ObservedSetting } from '../types/index';
import { arm, find, nextObservationId, record, update } from '../core/registry';
import { captureCallSite } from '../core/stack';
import { explicit, isRecord, unset } from '../core/settings';
import { FILLED_NOTE, plannedValue, policyMode, recordChange } from '../core/policy';

/**
 * Observes HTTP servers, including the one Express creates inside
 * `app.listen()`, because that path goes through `http.createServer` too.
 *
 * This is where the hardest problem in the package lives. `keepAliveTimeout`
 * defaults to 5000, so a developer who deliberately writes
 * `server.keepAliveTimeout = 5000` is indistinguishable **by value** from one
 * who never touched it. Intent is therefore taken from the *assignment*: an
 * accessor records who was written to, and the value is never used to guess.
 */

/** Node's own defaults, which is what happens when the setting is left alone. */
const NODE_DEFAULTS: Record<string, number> = {
  keepAliveTimeout: 5000,
  headersTimeout: 60000,
  requestTimeout: 300000,
  timeout: 0,
};

const TRACKED = Object.keys(NODE_DEFAULTS);

interface ServerState {
  readonly observationId: string;
  /** Settings the developer passed to createServer, or assigned afterwards. */
  readonly assigned: Set<string>;
  readonly values: Map<string, unknown>;
  readonly site: CallSite | undefined;
  /** Settings `applySafeDefaults()` filled, kept apart from the user's own. */
  readonly filled: Set<string>;
}

const servers = new WeakMap<Server, ServerState>();
const installed = { http: false, https: false };
let originals: { http?: typeof http.createServer; https?: typeof https.createServer } = {};

/** Servers seen so far, so `applySafeDefaults` can reach ones already built. */
const liveServers = new Set<WeakRef<Server>>();

function toSettings(state: ServerState): Record<string, ObservedSetting> {
  const out: Record<string, ObservedSetting> = {};
  for (const name of TRACKED) {
    const libraryDefault = NODE_DEFAULTS[name];
    if (state.assigned.has(name)) {
      out[name] = explicit(state.values.get(name), libraryDefault);
    } else if (state.filled.has(name)) {
      // Configured, but by us. The report must be able to tell the two apart,
      // so the note travels with the value.
      out[name] = { ...explicit(state.values.get(name), libraryDefault), note: FILLED_NOTE };
    } else {
      out[name] = unset(libraryDefault);
    }
  }
  return out;
}

function publish(server: Server): void {
  const state = servers.get(server);
  if (state === undefined) return;
  const previous = find(state.observationId);
  const observation: Observation = {
    id: state.observationId,
    subsystem: 'http',
    target: 'http.Server',
    library: 'node',
    libraryVersion: process.versions.node,
    settings: toSettings(state),
    site: state.site,
    observedAt: previous?.observedAt ?? Date.now(),
  };
  update(state.observationId, observation);
}

/**
 * Replaces each tracked property with an accessor.
 *
 * The getter returns the real value so Node's own internals keep working. The
 * setter is the whole point: it records that somebody chose this value,
 * whatever the value turns out to be.
 */
function track(server: Server, optionKeys: readonly string[], site: CallSite | undefined): void {
  if (servers.has(server)) return;

  const state: ServerState = {
    observationId: nextObservationId('http'),
    assigned: new Set(optionKeys.filter((k) => TRACKED.includes(k))),
    values: new Map(),
    site,
    filled: new Set(),
  };
  servers.set(server, state);
  liveServers.add(new WeakRef(server));

  for (const name of TRACKED) {
    const current = (server as unknown as Record<string, unknown>)[name];
    state.values.set(name, current);

    const descriptor = Object.getOwnPropertyDescriptor(server, name);
    // If the property is not configurable we cannot observe assignment, and
    // guessing from the value is exactly what this mechanism exists to avoid.
    if (descriptor !== undefined && descriptor.configurable === false) continue;

    Object.defineProperty(server, name, {
      configurable: true,
      enumerable: true,
      get: () => state.values.get(name),
      set: (value: unknown) => {
        state.assigned.add(name);
        state.values.set(name, value);
        publish(server);
      },
    });
  }

  record({
    id: state.observationId,
    subsystem: 'http',
    target: 'http.Server',
    library: 'node',
    libraryVersion: process.versions.node,
    settings: toSettings(state),
    site,
    observedAt: Date.now(),
  });

  // The developer's own `server.keepAliveTimeout = ...` runs in this same
  // tick, right after createServer returns. Waiting until the tick ends is
  // what lets an explicit assignment win over ours without us having to guess
  // from the value, which for a 5000ms default is impossible.
  if (isPolicyRelevant()) setImmediate(() => fillFromPolicy(server));
}

function isPolicyRelevant(): boolean {
  return TRACKED.some((name) => plannedValue('http', name) !== undefined);
}

/**
 * Fills the settings nobody assigned.
 *
 * In report mode this computes and logs exactly the same set of changes and
 * writes none of them, which is the migration shape that makes a tool like
 * this adoptable: you see what it would do before it does anything.
 */
function fillFromPolicy(server: Server): void {
  const state = servers.get(server);
  if (state === undefined) return;

  let changed = false;
  for (const name of TRACKED) {
    if (state.assigned.has(name) || state.filled.has(name)) continue;
    const planned = plannedValue('http', name);
    if (planned === undefined) continue;

    const enforcing = policyMode() === 'enforce';
    if (enforcing) {
      state.filled.add(name);
      state.values.set(name, planned.value);
      changed = true;
    }
    recordChange({
      subsystem: 'http',
      target: 'http.Server',
      setting: name,
      from: 'unset',
      to: planned.value,
      ruleId: planned.ruleId,
      applied: enforcing,
    });
  }
  if (changed) publish(server);
}

function optionKeysOf(args: readonly unknown[]): string[] {
  const first = args[0];
  return isRecord(first) && typeof first !== 'function' ? Object.keys(first) : [];
}

function wrapCreateServer<T extends (...args: never[]) => Server>(original: T): T {
  const wrapped = function createServer(this: unknown, ...args: never[]): Server {
    const server = original.apply(this, args);
    try {
      track(server, optionKeysOf(args), captureCallSite(wrapped as never));
    } catch {
      // A broken observer must never stop a server from being created.
    }
    return server;
  };
  return wrapped as unknown as T;
}

export function installHttpServerObserver(): void {
  if (!installed.http) {
    originals.http = http.createServer;
    http.createServer = wrapCreateServer(http.createServer);
    installed.http = true;
  }
  if (!installed.https) {
    originals.https = https.createServer;
    https.createServer = wrapCreateServer(https.createServer);
    installed.https = true;
  }
  arm('http');
}

/** Whether the developer assigned a setting themselves. Used by the tests. */
export function wasAssigned(server: Server, setting: string): boolean {
  return servers.get(server)?.assigned.has(setting) ?? false;
}

/** Servers observed so far that have not been garbage collected. */
export function observedServers(): Server[] {
  const alive: Server[] = [];
  for (const ref of liveServers) {
    const server = ref.deref();
    if (server === undefined) liveServers.delete(ref);
    else alive.push(server);
  }
  return alive;
}

export function serverObservationId(server: Server): string | undefined {
  return servers.get(server)?.observationId;
}

export function isHttpServerObserverInstalled(): boolean {
  return installed.http;
}

/** Test-only. */
export function uninstallHttpServerObserver(): void {
  if (installed.http && originals.http) http.createServer = originals.http;
  if (installed.https && originals.https) https.createServer = originals.https;
  installed.http = false;
  installed.https = false;
  originals = {};
  liveServers.clear();
}
