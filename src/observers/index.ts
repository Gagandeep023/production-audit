import type { SubsystemToggles } from '../types/index';
import { installDiagnosticsObserver } from './diagnostics';
import { installFetchObserver } from './fetch';
import { installHttpServerObserver } from './httpServer';
import { installPgObserver } from './pgPool';

export {
  installDiagnosticsObserver,
  observedOrigins,
  observedRequestCount,
} from './diagnostics';
export {
  installFetchObserver,

  uninstallFetchObserver,
} from './fetch';
export {
  installHttpServerObserver,
  wasAssigned,
  observedServers,
  serverObservationId,
  uninstallHttpServerObserver,
} from './httpServer';
export { installPgObserver, wrapPgExports } from './pgPool';
export { installModuleHook, onModuleLoad } from './moduleHook';

/**
 * Installs every observer. All of them are record-only: nothing here changes
 * behaviour, which is what makes the audit half safe to run first.
 */
export function installObservers(toggles: SubsystemToggles = {}): void {
  const all = toggles.fetch === undefined && toggles.http === undefined && toggles.pg === undefined;

  if (all || toggles.fetch) {
    installFetchObserver();
    installDiagnosticsObserver();
  }
  if (all || toggles.http) installHttpServerObserver();
  if (all || toggles.pg) installPgObserver();
}
