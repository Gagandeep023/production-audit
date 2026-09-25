import { applySafeDefaults } from './apply/applySafeDefaults';
import { observe, audit } from './index';
import { isProfile } from './core/profile';

/**
 * Preload entry point.
 *
 * ```
 * node --import @gagandeep023/production-audit/register app.js
 * ```
 *
 * This exists because a function call cannot do the job on its own. ESM
 * imports are hoisted and evaluated before any of your code runs, so by the
 * time `applySafeDefaults()` executes at the top of your entry file, `pg` is
 * already loaded and `Pool` is a binding somebody else is holding. Patching
 * the module export afterwards does not reach it.
 *
 * A preload registers before the application's first import resolves, which is
 * the same problem OpenTelemetry has and the same solution.
 *
 * Environment:
 *   PRODUCTION_AUDIT=enforce    fill unset values instead of only reporting
 *   PRODUCTION_AUDIT_PROFILE    http-api (default) | worker | cli
 *   PRODUCTION_AUDIT_REPORT=off suppress the report at exit
 */

const mode = process.env['PRODUCTION_AUDIT'];
const profileEnv = process.env['PRODUCTION_AUDIT_PROFILE'];
const profile = isProfile(profileEnv) ? profileEnv : undefined;

if (mode === 'enforce' || mode === 'report') {
  applySafeDefaults(profile === undefined ? { mode } : { mode, profile });
} else {
  observe();
}

if (process.env['PRODUCTION_AUDIT_REPORT'] !== 'off') {
  // Printed at exit rather than at boot, because a pool constructed lazily on
  // the first query does not exist yet when the process starts, and a report
  // that misses it is worse than no report.
  process.on('exit', () => {
    try {
      process.stderr.write(`${audit(profile === undefined ? {} : { profile }).report}\n`);
    } catch {
      // Never turn a clean shutdown into a crash.
    }
  });
}

export {};
