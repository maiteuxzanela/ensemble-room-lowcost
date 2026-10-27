# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `0.18.3` (current) | Yes — security fixes are released on this line |
| `0.18.x` | Yes — previous patches remain installable, but fixes land on `0.18.3` |
| `< 0.18.0` | No |

Only the latest patch of the supported minor line receives security fixes. Upgrading is always the
recommended remediation.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository:

1. Go to the **Security** tab of `github.com/maiteuxzanela/ensemble-room-lowcost`.
2. Click **Report a vulnerability**.
3. Describe the issue with enough detail to reproduce it.

A good report includes:

- Affected version (`package.json` value or bundle commit).
- The affected component: plugin runtime (`dist/index.js`), source (`src/`), dashboard HTTP server,
  SQLite migration path, or the messaging/wake pipeline.
- Reproduction steps or a minimal proof of concept.
- Observed impact and the preconditions an attacker needs.
- Whether the issue also affects the upstream base `@hueyexe/opencode-ensemble@0.18.0`.

Do not include real credentials, provider API keys or production data in the report. Redact them.

## Response targets

| Stage | Target |
|---|---|
| Acknowledgement of the report | within 72 hours |
| Initial triage and severity assessment | within 7 calendar days |
| Fix or documented mitigation for critical/high issues | within 30 calendar days |
| Coordinated public disclosure | after a fix is available, by mutual agreement |

These are targets, not contractual guarantees. If a fix requires coordination with the upstream project
or an affected provider, the timeline will be communicated in the report thread.

## Scope

In scope:

- The plugin runtime and its distributed bundle (`dist/index.js`).
- The local dashboard HTTP server (binding, Host/Origin validation, endpoint authorization, input
  handling).
- SQLite schema and migration logic (`src/schema.ts`), including upgrade paths that could corrupt or
  leak data.
- The wake and messaging pipeline: standby wake guards, silent lead delivery, message durability.
- Model fallback resolution, including any path that could leak selectors, credentials or session
  identifiers.
- Tool deny-list enforcement for spawned teammates.

Out of scope:

- Vulnerabilities in OpenCode itself, in a model provider, or in a third-party package — report those
  upstream. We will still relay a report when it is directly relevant.
- Issues that require an already-compromised host account, root access, or physical access.
- Social-engineering scenarios against operators.
- Denial of service caused by deliberately oversized local configuration files.
- Findings that only affect unsupported versions.

## Package lineage and supply-chain provenance

An external release audit flagged the coexistence of `@opencode/plugin` and `@opencode-ai/plugin` as a
possible typosquatting / supply-chain risk. It is not. Both namespaces are legitimate and have different
owners and purposes:

| Package | Role | Lineage |
|---|---|---|
| `@opencode-ai/plugin` | v1 plugin/tool SDK (`tool`, `Plugin` types) | OpenCode official SDK namespace, used here for tool definitions and types |
| `@opencode-ai/sdk` | v1 server/client SDK (`OpencodeClient`) | Same official namespace |
| `@opencode/plugin` | v2 plugin SDK: `Plugin` from the root, `Rpc` from `@opencode/plugin/rpc`, TUI helpers from `@opencode/plugin/tui` | Maintained by **Dax Raad (`thdxr`)**, creator and architect of OpenCode |

How the runtime uses them:

- `src/index.ts` imports `Plugin` from `@opencode/plugin` and also re-exports the legacy `server()` shape
  from `@opencode-ai/plugin` (dual V1/V2 compatibility, upstream issue #36).
- `src/rpc.ts` imports `Rpc` from `@opencode/plugin/rpc`; `src/tui.tsx` imports `Plugin` from
  `@opencode/plugin/tui`. Both are companion entrypoints and are optional at runtime.

Verification properties that make the dependency auditable:

- `@opencode/plugin` is pinned to an **exact version** (`2.0.16`) — no `^`, `~` or `latest` range — and
  `package-lock.json` records the `registry.npmjs.org` tarball plus its `sha512` integrity hash.
  `npm ci` therefore installs byte-identical code.
- The package is published on the public npm registry under the `@opencode` scope with the same maintainer
  as OpenCode itself; it is not an unowned, look-alike name.
- `npm audit --omit=dev` reports **0 vulnerabilities** for the runtime dependency tree.
- `@opencode/plugin`, `@opencode-ai/plugin` and `@opencode-ai/sdk` are declared as regular
  `dependencies` (not post-install hooks, not git URLs, not tarball URLs); no package in the runtime tree
  prompts for credentials or installs from a non-registry source.

To audit the claim yourself:

```bash
npm ls @opencode/plugin @opencode-ai/plugin @opencode-ai/sdk
npm view @opencode/plugin version maintainers   # → maintainer: thdxr <d@ironbay.co>
npm audit --omit=dev
```

If a future release needs a different package from the `@opencode*` families, it must be added by an
explicit, reviewed change to `package.json` with an exact version and a lockfile diff — never as a
transitive surprise.

## Secure operating assumptions

The runtime is designed as a **local, single-operator** tool:

- The dashboard binds to loopback (`127.0.0.1`) and rejects requests whose `Host`/`Origin` do not match.
  Exposing it behind a reverse proxy without preserving the original `Host` header is unsupported.
- The host session store (`opencode.db`) is opened **read-only**. The runtime must never need write
  access to it.
- The runtime stores no provider credentials. Model access is delegated to the host's own provider
  configuration; keep that configuration outside the repository.
- Spawned teammates receive an integrity deny-list (`team_create`, `team_cleanup`, `team_merge`,
  `team_shutdown`, `task`, `todowrite`), optionally extended through the `deniedTools` configuration key.
  Denial is additive across scopes: a project file can never re-enable a globally denied tool.
- Multi-agent orchestration implies executing tool calls requested by models. Treat any untrusted
  repository content as potential prompt-injection input and keep human review on destructive operations
  (commits, pushes, merges, shutdowns).

## Disclosure policy

We follow coordinated disclosure. Once a fix is released, we publish an advisory describing the issue,
the affected versions and the remediation, and credit the reporter unless anonymity is requested.

## Security-relevant configuration checklist

When operating the runtime, verify:

- [ ] `dashboardPort` is either `0` (disabled) or reachable only from loopback.
- [ ] No `ensemble.json` in a shared repository contains internal hostnames, tokens or provider secrets.
- [ ] `deniedTools` covers ecosystem-specific tools that must never be available to workers.
- [ ] The plugin version pinned in `opencode.json` is the supported line (`0.18.x`).
- [ ] Local commits produced by the runtime are reviewed before any push to a remote.
