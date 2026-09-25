import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * Interception for libraries that have no diagnostics channel.
 *
 * `Module._load` is wrapped so a named package can be handed to a wrapper the
 * first time it is loaded, before the application gets its reference. This is
 * the same mechanism `require-in-the-middle` and the OpenTelemetry
 * instrumentations use, and it is why the package works from a `--import`
 * preload but only partially from a function call: by the time your code runs,
 * ESM has already evaluated the imports above it.
 *
 * It covers CommonJS packages, which includes `pg` and most database drivers,
 * because a native-ESM package is resolved by the ESM loader and never reaches
 * `Module._load`. That limit is documented rather than papered over.
 */

type Wrapper = (exports: unknown, version: string | undefined) => unknown;

const wrappers = new Map<string, Wrapper>();
const wrapped = new Set<string>();
let installed = false;
let originalLoad: Load | null = null;

/**
 * `Module._load` is not in the public typings, but it is the only hook that
 * sees a CommonJS dependency before the requiring module does.
 */
type Load = (request: string, parent: unknown, isMain: boolean) => unknown;

interface LoaderInternals {
  _load: Load;
}

/** Reads the installed version so `versionRange` on a rule can be honoured. */
function resolveVersion(name: string, parentFilename: string | undefined): string | undefined {
  try {
    const from = parentFilename ?? process.cwd() + '/index.js';
    const require = createRequire(from);
    const manifestPath = require.resolve(`${name}/package.json`);
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    // A package can block deep imports with an `exports` map. Unknown version
    // makes version-scoped rules inert, which is the safe direction.
    return undefined;
  }
}

export function onModuleLoad(name: string, wrapper: Wrapper): void {
  wrappers.set(name, wrapper);
}

export function installModuleHook(): void {
  if (installed) return;
  const loader = Module as unknown as LoaderInternals;
  const original = loader._load;
  originalLoad = original;
  installed = true;

  loader._load = function _load(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    const exports = original.call(this, request, parent, isMain);

    const wrapper = wrappers.get(request);
    if (wrapper === undefined || wrapped.has(request)) return exports;

    wrapped.add(request);
    try {
      const parentFilename = (parent as { filename?: string } | undefined)?.filename;
      return wrapper(exports, resolveVersion(request, parentFilename)) ?? exports;
    } catch {
      // A failed wrap must never stop the application from loading its own
      // dependency. Observation is not worth an outage.
      return exports;
    }
  };
}

export function isModuleHookInstalled(): boolean {
  return installed;
}

/** Test-only. */
export function uninstallModuleHook(): void {
  if (installed && originalLoad !== null) {
    (Module as unknown as LoaderInternals)._load = originalLoad;
  }
  installed = false;
  originalLoad = null;
  wrappers.clear();
  wrapped.clear();
}
