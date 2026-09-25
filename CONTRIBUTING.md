# Contributing

The most useful thing you can send is a rule. Every entry in the corpus
is somebody's postmortem turned into a check everyone else inherits for
free, and that is the part of this project that grows without the
maintainer doing all the work.

## Adding a rule

Rules are data. You do not need to read the source.

1. Open `src/rules/corpus/<library>.json`, or create it.
2. Add a record.
3. Run `npm test`. The corpus is validated by its own test, so a
   malformed rule fails in CI rather than landing as a check that
   silently never matches.

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
  "fixSnippet": {
    "context": ["createClient({"],
    "added": ["  commandTimeout: 5_000,"]
  },
  "safeDefaults": { "commandTimeout": 5000 },
  "incident": "https://link-to-a-public-postmortem"
}
```

### Fields

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `library/what-is-wrong`, lowercase and hyphenated |
| `library` | yes | Matched against the observed library name |
| `target` | no | Narrows to one target, e.g. `pg.Pool` |
| `versionRange` | no | `>=8`, `^4.1`, `5 - 7`. Inert if the version cannot be read |
| `settings` | yes | The settings the condition is tested against |
| `match` | no | `any` (default) or `all` |
| `dangerousWhen` | yes | See below |
| `severity` | yes | `critical`, `high`, `medium`, `low`, `info` |
| `why` | yes | The consequence, not the value |
| `fix` | yes | What to write |
| `fixSnippet` | no | Rendered as a diff |
| `safeDefaults` | no | What `applySafeDefaults()` writes |
| `profiles` | no | Restricts the rule to some profiles |
| `profileOverrides` | no | Different values per profile, `null` to disable |
| `incident` | no | A public postmortem. The whole point |

### Conditions

```jsonc
"unset"                                        // nobody configured it
{ "kind": "equals", "value": 0 }
{ "kind": "unsetOr", "value": 0 }              // unset, or set to "no limit"
{ "kind": "lessThan", "value": 1000 }
{ "kind": "greaterThan", "value": 60000 }
{ "kind": "lessThanSetting", "setting": "keepAliveTimeout" }
```

`lessThanSetting` is the interesting one. It expresses a relationship
between two observed values, which is the class of finding a static
linter cannot reach.

## What makes a good rule

- **The `why` explains the consequence.** "connectionTimeoutMillis is 0"
  reads as fast to anyone who has not been bitten by it. Say what
  happens under load.
- **It fires on a default and stays silent on a deliberate choice.** A
  rule that fires on configuration somebody thought about gets the whole
  tool muted.
- **Severity reflects blast radius.** `critical` is reserved for
  defaults that take the service down, not ones that make it slow.
- **Profiles when the right answer differs.** If your number is wrong
  for a batch worker, say so with `profileOverrides` instead of
  shipping a finding a worker has to suppress.
- **`safeDefaults` only when there is an answer everyone would accept.**
  Leaving it out makes the rule report-only, which is a fine place for a
  check to live.
- **Settings that have to move together belong in one rule.** Raising
  `keepAliveTimeout` without raising `headersTimeout` trips a different
  check, so both are listed with `"match": "all"`.

## Adding an observer

Harder, and worth discussing in an issue first. An observer's job is to
record what a library was actually configured with, plus the call site.
Three constraints:

- **Record-only by default.** Nothing may change behaviour unless the
  policy says `enforce`.
- **Presence of the key decides, not the value.** See
  `src/core/settings.ts`. Judging intent from a value is the one
  mistake that makes `applySafeDefaults()` unsafe.
- **Never break the thing you are watching.** Every observation is
  wrapped in a `try`, and a failed wrap returns the original.

## Running things

```bash
npm install
npm test          # builds first, the integration test runs against dist
npm run typecheck
npm run lint
```

The integration test spawns a real child process under the real preload
against fixtures in `test/fixtures/`. It is the only place where the
module hook, the diagnostics channel subscription and the accessor-based
assignment tracking all have to work at once.

## Tests to add with a rule

The suite is weighted towards silence, because false positives are what
kill a tool like this.

- A fixture configured the way the rule wants produces **zero**
  findings.
- A default-configured fixture produces the finding, with the right
  severity and location.
- If the rule has `safeDefaults`, assert `applySafeDefaults()` does not
  override an explicit value, including one that equals the library
  default.
