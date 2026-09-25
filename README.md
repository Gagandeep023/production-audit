# @gagandeep023/production-audit

Runtime audit for the Node defaults that cause outages.

`fetch()` has no timeout and waits forever. A `pg` pool's
`connectionTimeoutMillis` defaults to `0`, which means a request waiting
for a free connection waits forever too. An HTTP server closes idle
keep-alive sockets after 5 seconds, which is 55 seconds before the load
balancer in front of it expects.

None of that can be fixed at the source. Making `fetch()` time out by
default would break every existing user, so these defaults are frozen by
backwards compatibility, indefinitely. This package runs inside your
booted application, reports what the objects actually are, and tells you
the line to change.

Zero runtime dependencies. Report-only unless you ask for more.

```bash
npm install @gagandeep023/production-audit
```

## Why not a linter

A linter reads your source and sees `new Pool()`. It cannot know the
effective value, because that does not exist until environment
variables, config merging, framework defaults and the installed version
of the library have all had their say. Two apps with identical source
can have different effective pool sizes.

The most valuable findings are worse than that: they are relationships
between two numbers, and one of them is not in your codebase at all.

```
server.keepAliveTimeout (5000ms) < load balancer idle timeout (60000ms)
  -> intermittent 502s that reproduce nowhere else
```

So this runs in the process and introspects the real objects.

## Quick start

The CLI runs your app with the observers attached and prints a report
when it exits.

```bash
npx production-audit run dist/server.js
```

```
production-audit
profile http-api, node v22.22.0, 4 observed
watched: fetch, http, pg, undici

4 findings: 2 critical, 2 high

CRITICAL pg.Pool connectionTimeoutMillis unset, so the library
      default of 0 applies
      pg/pool-connection-timeout-unbounded
      at src/db/index.ts:14

      connectionTimeoutMillis defaults to 0, which means a caller
      waiting for a free pooled connection waits forever. Under load
      every request queues silently and the symptom reads as a slow
      database, while the database itself is idle and healthy.

        new Pool({
          connectionString,
      +   connectionTimeoutMillis: 5_000,
```

The location is the point. "A pool somewhere has no timeout" is true
and useless.

## The two entry points, and what each one misses

```bash
node --import @gagandeep023/production-audit/register app.js
```

```ts
import { observe, audit } from '@gagandeep023/production-audit';

observe();
// ... boot, take some traffic ...
console.log(audit().report);
```

| Entry | Covers | Misses |
|---|---|---|
| `--import .../register` | Everything, wrapped at module load | Native-ESM packages, see Limits |
| `observe()` / `applySafeDefaults()` | Globals like `fetch`, plus anything constructed after the call | Modules your app already imported |

The difference is real and worth understanding. ESM imports are hoisted
and evaluated before any of your own code runs:

```js
import { Pool } from 'pg';                    // evaluated first
import { observe } from '@gagandeep023/...';  // and this
observe();                                    // only now do we run
```

By the time that call executes, `pg` is loaded and `Pool` is a binding
somebody else is holding. Patching the module export afterwards does not
reach it. A preload registers before the application's first import
resolves. This is the same problem OpenTelemetry has, and the same
solution.

## Filling in the defaults

For a codebase you are not going to edit, one line at the top of the
entrypoint:

```ts
import { applySafeDefaults } from '@gagandeep023/production-audit';

applySafeDefaults();
```

That call is **report mode**. It computes exactly what it would change,
logs it, and changes nothing. Turn it on when you have read the list:

```ts
applySafeDefaults({ mode: 'enforce', http: true, pg: false });
```

Four rules keep this from becoming the incident it exists to prevent:

1. **Only unset values are filled.** A deliberate
   `connectionTimeoutMillis: 0` stands, because you meant it. Intent is
   taken from *assignment*, never from the value: `keepAliveTimeout`
   defaults to `5000`, so `server.keepAliveTimeout = 5000` is
   indistinguishable by value from never touching it, and an accessor
   records which one happened.
2. **Every change is logged, loudly.** Silent behaviour modification is
   how a helpful library becomes a three-hour debugging session six
   months later.

   ```
   production-audit: set pg.Pool connectionTimeoutMillis = 5000
     (was unset) [pg/pool-connection-timeout-unbounded]
   ```
3. **Subsystems are opted into individually.** All-or-nothing means you
   either take risks you did not evaluate or skip the feature.
4. **Report mode is the default.** Nobody puts an unfamiliar library in
   the boot path of a production service in enforce mode on day one.

## Profiles

One timeout number is right for a payment path and wrong for a batch
worker. Without profiles the tool produces a wall of findings that are
correct in general and wrong here, and a tool like that gets muted once
and never looked at again.

```bash
production-audit run --profile worker dist/worker.js
PRODUCTION_AUDIT_PROFILE=worker node --import .../register app.js
```

`http-api` (default), `worker`, `cli`. A profile can disable a rule
outright or give it a different value: `statement_timeout` is 30s on an
API, 300s on a worker, and not checked at all on a CLI.

## Suppressions

A suppression must say why and must expire. Without both, the list
becomes a graveyard nobody revisits, so an expired entry turns back into
a finding.

```ts
audit({
  suppressions: [
    {
      ruleId: 'pg/pool-connection-timeout-unbounded',
      reason: 'migration in flight, tracked in OPS-412',
      expires: '2026-12-01',
    },
  ],
});
```

An expired suppression whose rule no longer fires is reported at `info`,
so stale entries get deleted rather than accumulating.

## Rules are data

Every check is a JSON record in `src/rules/corpus/`, one file per
library. Contributing one needs no knowledge of the internals:

```jsonc
{
  "id": "redis/no-command-timeout",
  "library": "redis",
  "versionRange": ">=4",
  "settings": ["commandTimeout"],
  "dangerousWhen": "unset",
  "severity": "high",
  "why": "A command with no timeout holds its connection until the
          server answers, which under a network partition is never.",
  "fix": "Set commandTimeout on the client.",
  "safeDefaults": { "commandTimeout": 5000 },
  "incident": "https://link-to-a-public-postmortem"
}
```

Every entry is somebody's postmortem turned into a check everyone else
inherits for free. See [CONTRIBUTING.md](https://github.com/Gagandeep023/production-audit/blob/master/CONTRIBUTING.md).

```bash
production-audit rules                       # list the corpus
production-audit explain pg/no-statement-timeout
production-audit validate my-rules.json
```

## What it checks today

| Rule | Severity |
|---|---|
| `undici/fetch-no-timeout` | critical |
| `pg/pool-connection-timeout-unbounded` | critical |
| `pg/no-statement-timeout` | high |
| `http/keep-alive-timeout-unset` | high |
| `http/headers-timeout-below-keep-alive` | high |
| `http/request-timeout-disabled` | high |
| `pg/pool-idle-timeout-disabled` | medium |

## Limits

Stated here rather than discovered later.

- **Native-ESM packages are not intercepted.** The module hook wraps
  CommonJS loads, which covers `pg` and most drivers. A package shipping
  only ESM resolves through a different path and is missed. Globals and
  `node:http` are unaffected.
- **A setting that cannot be read is reported as `unknown`, not as
  fine.** Passing a custom `dispatcher` to `fetch` is the common case:
  its timeouts are not visible from outside undici, so the finding says
  so instead of guessing.
- **A version-scoped rule stays inert when the installed version cannot
  be resolved.** Firing would be a guess, and a guessed finding you
  cannot verify is how a tool earns a permanent mute.
- **Only what ran is checked.** A pool constructed lazily on the first
  query does not exist at boot. The report is printed at exit for that
  reason, and the "watched but never exercised" line tells you what was
  watched and never happened.
- **Server-side Node only.** Browser defaults are a different problem
  with different owners.
- **`production-audit fix --write` does not exist yet.** Every finding
  already carries the exact lines; the codemod that writes them for you
  is not built.

## API

```ts
observe(toggles?)           // install record-only observers
audit(config?)              // evaluate: findings, report, json
applySafeDefaults(options?) // fill unset values, report mode by default
builtinRules()              // the corpus
validateRules(rules)        // for CI on a contributed rule file
```

`audit()` returns `{ config, findings, report, json, worst }`. Use
`worst` for a CI gate.

## Environment

| Variable | Effect |
|---|---|
| `PRODUCTION_AUDIT` | `report` or `enforce`. Unset means observe only |
| `PRODUCTION_AUDIT_PROFILE` | `http-api`, `worker`, `cli` |
| `PRODUCTION_AUDIT_REPORT` | `off` to suppress the report at exit |

The profile is an environment variable because the same image usually
ships as both an API and a worker, and the difference is a start command
rather than a code change.

## Requests and feedback

[![Request a feature](https://img.shields.io/badge/request-a%20feature-64ffda)](https://github.com/Gagandeep023/production-audit/discussions/new?category=ideas)
[![Report a bug](https://img.shields.io/badge/report-a%20bug-cc4444)](https://github.com/Gagandeep023/production-audit/issues/new?template=bug_report.yml)

Ideas and questions go to Discussions, bugs to Issues. A new rule is the
most useful thing you can send.

## License

MIT
