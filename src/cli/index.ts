import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinRules, parseRules } from '../rules/index';
import { validateRules } from '../rules/schema';
import { SEVERITY_ORDER, severityRank } from '../types/index';
import type { Profile, Rule } from '../types/index';
import { isProfile } from '../core/profile';
import { VERSION } from '../version';

/**
 * `production-audit run | explain | rules | validate | fix`
 *
 * `run` is the one that matters. It starts your application with the preload
 * attached, which is the only way to reach a dependency the application has
 * already imported, and prints the report when the process exits.
 */

export const USAGE = `
production-audit ${VERSION} - runtime audit for dangerous library defaults

Usage:
  production-audit run <entry> [args...]   Run an app under audit and report
  production-audit explain <rule-id>       Show one rule in full
  production-audit rules                   List the rule corpus
  production-audit validate <file.json>    Validate a rule file
  production-audit fix                     Not implemented yet, see below
  production-audit --help

Options for run:
  --profile <name>   http-api (default) | worker | cli
  --enforce          Fill unset values instead of only reporting them
  --quiet            Suppress the report at exit

Examples:
  production-audit run dist/server.js
  production-audit run --profile worker dist/worker.js
  production-audit explain pg/pool-connection-timeout-unbounded
`.trimStart();

export interface CliResult {
  readonly stdout: string;
  readonly exitCode: number;
}

function ok(stdout: string): CliResult {
  return { stdout, exitCode: 0 };
}

function fail(stdout: string, exitCode = 1): CliResult {
  return { stdout, exitCode };
}

/** `dist/cli/bin.js` -> `dist/register.js`, so the preload is always ours. */
export function registerPath(cliDir: string): string {
  return join(cliDir, '..', 'register.js');
}

export interface RunOptions {
  readonly cliDir: string;
  /** Injected in tests so the CLI can be exercised without spawning Node. */
  readonly spawn?: typeof spawnSync;
}

export function runCommand(args: readonly string[], options: RunOptions): CliResult {
  const rest: string[] = [];
  let profile: Profile | undefined;
  let enforce = false;
  let quiet = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--profile' && i + 1 < args.length) {
      const value = args[i + 1] as string;
      if (!isProfile(value)) return fail(`Unknown profile: ${value}\n`);
      profile = value;
      i += 1;
    } else if (arg === '--enforce') enforce = true;
    else if (arg === '--quiet') quiet = true;
    else rest.push(arg);
  }

  const entry = rest[0];
  if (entry === undefined) return fail('Error: an entry file is required.\n\n' + USAGE);

  const spawn = options.spawn ?? spawnSync;
  const result = spawn(
    process.execPath,
    ['--import', registerPath(options.cliDir), ...rest],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        PRODUCTION_AUDIT: enforce ? 'enforce' : 'report',
        ...(profile === undefined ? {} : { PRODUCTION_AUDIT_PROFILE: profile }),
        ...(quiet ? { PRODUCTION_AUDIT_REPORT: 'off' } : {}),
      },
    },
  );

  return { stdout: '', exitCode: result.status ?? 1 };
}

function formatRule(rule: Rule): string {
  const lines: string[] = [];
  lines.push(rule.id);
  lines.push(`  severity   ${rule.severity}`);
  lines.push(`  library    ${rule.library}${rule.versionRange ? ` ${rule.versionRange}` : ''}`);
  if (rule.target !== undefined) lines.push(`  target     ${rule.target}`);
  lines.push(`  settings   ${rule.settings.join(', ')}`);
  lines.push(`  dangerous  ${JSON.stringify(rule.dangerousWhen)}`);
  if (rule.profiles !== undefined) lines.push(`  profiles   ${rule.profiles.join(', ')}`);
  lines.push('');
  lines.push(`  ${rule.why}`);
  lines.push('');
  lines.push(`  Fix: ${rule.fix}`);
  if (rule.safeDefaults !== undefined) {
    lines.push(`  applySafeDefaults writes: ${JSON.stringify(rule.safeDefaults)}`);
  }
  if (rule.incident !== undefined) lines.push(`  Incident: ${rule.incident}`);
  return lines.join('\n');
}

export function explainCommand(args: readonly string[]): CliResult {
  const id = args[0];
  if (id === undefined) return fail('Error: a rule id is required.\n\n' + USAGE);

  const rule = builtinRules().find((r) => r.id === id);
  if (rule === undefined) {
    const known = builtinRules()
      .map((r) => `  ${r.id}`)
      .join('\n');
    return fail(`Unknown rule: ${id}\n\nKnown rules:\n${known}\n`);
  }
  return ok(`${formatRule(rule)}\n`);
}

export function rulesCommand(): CliResult {
  const rules = builtinRules()
    .slice()
    .sort((a, b) => {
      const bySeverity = severityRank(a.severity) - severityRank(b.severity);
      return bySeverity !== 0 ? bySeverity : a.id.localeCompare(b.id);
    });

  const width = Math.max(...SEVERITY_ORDER.map((s) => s.length));
  const lines = rules.map((rule) => `${rule.severity.padEnd(width)}  ${rule.id}`);
  return ok(`${lines.join('\n')}\n\n${rules.length} rules.\n`);
}

export function validateCommand(args: readonly string[]): CliResult {
  const file = args[0];
  if (file === undefined) return fail('Error: a file path is required.\n\n' + USAGE);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`Could not read ${file}: ${(error as Error).message}\n`);
  }
  if (!Array.isArray(parsed)) return fail(`${file} must contain an array of rules.\n`);

  const errors = validateRules(parsed);
  if (errors.length > 0) {
    const lines = errors.map((e) => `  ${e.ruleId}: ${e.field} ${e.message}`);
    return fail(`${errors.length} problem(s) in ${file}:\n${lines.join('\n')}\n`);
  }
  parseRules(parsed);
  return ok(`${parsed.length} rule(s) in ${file} are valid.\n`);
}

/**
 * The codemod is deliberately the last thing built. Saying so beats shipping a
 * stub that half works on somebody's source tree.
 */
export function fixCommand(): CliResult {
  return fail(
    'production-audit fix is not implemented yet.\n\n' +
      'Every finding already carries the exact lines to add, from `run`.\n' +
      'The codemod that writes them for you is tracked at\n' +
      'https://github.com/Gagandeep023/production-audit/issues\n',
  );
}

export function runCli(argv: readonly string[], options: RunOptions): CliResult {
  const [command, ...args] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    return command === undefined ? fail(USAGE) : ok(USAGE);
  }
  if (command === '--version' || command === '-v') return ok(`${VERSION}\n`);

  switch (command) {
    case 'run':
      return runCommand(args, options);
    case 'explain':
      return explainCommand(args);
    case 'rules':
      return rulesCommand();
    case 'validate':
      return validateCommand(args);
    case 'fix':
      return fixCommand();
    default:
      return fail(`Unknown command: ${command}\n\n${USAGE}`);
  }
}
