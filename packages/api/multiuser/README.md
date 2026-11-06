---
description: "Account login, browser login-session revocation, workspace ownership, and the per-user Remote access policy for a multiuser Web deployment."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-multiuser

English | [中文](README.zh.md)

## Summary

`MultiuserService` authenticates browser requests, persists accounts and login sessions, assigns one owner to each workspace, and registers the `user` Remote access policy. It installs Connection's admission provider so every RPC, stream, index render, and upgrade speaks for the login's Peer rather than the owner. Workspace and Session controllers reuse that identity for their own resource checks and list filtering.

## Table of Contents

- [Behavior](#behavior)
- [Routes](#routes)
- [Remote access policy](#remote-access-policy)
- [Configuration](#configuration)
- [Workspace creation](#workspace-creation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="behavior"></a>
## Behavior

The service opens the `multiuser` storage domain (accounts, login sessions, workspace owners), loads it before serving requests, and installs itself as Connection's admission provider. A browser cookie holds a random 32-byte token; storage keeps only its SHA-256 digest. Passwords use scrypt with a per-account salt. A successful request carries a Peer whose principal is `{ kind: 'user', userId }`; missing, expired, revoked, or disabled logins are refused with 401 before any business method runs.

The service registers the `user` Remote access policy. The global role opens only listing, follow, controlled workspace creation, and model-catalog calls. Each owned workspace contributes a workspace grant, and each session accounted by an owned workspace contributes a session grant. Methods that touch a resource the account does not own are denied before dispatch; workspace and session reads filter through `remoteAccess.allows()` in the existing controllers. `workspace/follow` permits reading both owned workspaces and their Session membership; `session/create` permits reusing a blank Session in an owned workspace.

<a id="routes"></a>
## Routes

| Route | Method | Behavior |
| --- | --- | --- |
| `/auth/login` | POST | Bounded JSON login, origin-checked, rate-limited; sets an HttpOnly cookie. |
| `/auth/logout` | POST | Revokes the current login, disposes its Peer, clears the cookie; idempotent. |
| `/auth/me` | GET | Returns the current account or 401. |
| `/auth/client.js` | GET | Login document and account badge helper. |
| `/auth/sign-in` | GET | Public login page, without the application or private boot state. |

Unauthenticated index requests redirect to the public `/auth/sign-in` document. Authenticated pages show the account and a logout control. Login changes refresh other tabs, and switching accounts clears browser-persisted application views before boot. A failed logout stays visible and can be retried. Active Peers expire at the login deadline; authentication responses and personalized index documents are not cacheable.

<a id="remote-access-policy"></a>
## Remote access policy

The `user` policy denies by default and grants actions only on resources the account currently owns.

| Scope | Allowed actions | Notes |
| --- | --- | --- |
| global | `workspace/create`, `workspace/follow`, `session/list`, `session/search`, `session/control`, `session/modelCatalog`, `session/canOpenWorkspacePath` | Listing and follow methods filter each item through `ctx.remoteAccess.allows()`. |
| workspace | `session/create`, `workspace/follow`, `workspace/rename`, `workspace/delete`, `workspace/insertBefore`, `workspace/insertSessionBefore` | Conditions recheck the ownership row at decision time. |
| session | `workspace/follow`, `session/create`, `session/list`, `session/search`, `session/control`, `session/page`, `session/events`, `session/observeEvent`, `session/observeProjections`, `session/state`, `session/observeState`, `session/wait`, `session/follow`, `session/projections`, `session/prompt`, `session/updateQueue`, `session/cancel`, `session/rename`, `session/fork`, `session/selectModel`, `workspace/insertSessionBefore`, `workspace/archiveSession`, `workspace/unarchiveSession`, `workspace/pinSession`, `workspace/unpinSession`, and the five `event:api-session/*` notifications | Session membership comes from the authoritative workspace record. |

Everything else is denied before dispatch, including `workspace/initializeDefault`, cwd-only `session/create`, model-default writes, attachment reads, file services, terminal, jobs, settings, credentials, and exact Fetch routes. A denied request reports `remote-access/denied` with `reason: "not-found"` for a non-global resource, so another account's identity is not disclosed.

<a id="configuration"></a>
## Configuration

```yaml
- id: multiuser
  name: '@deepseek-ai/dsh-api-multiuser'
  config:
    workspaceRoot: /absolute/private/workspaces
```

Login attempts, including concurrent attempts, reserve the per-address limit before password hashing. Login and ownership records reject malformed timestamps when loaded.

`workspaceRoot` is required and must be absolute. `loginMaxAgeDays`, `loginAttemptLimit`, `loginAttemptWindowMs`, and `sessionSweepIntervalMs` are validated deployment values. `apps/web/tests/multiuser.overlay.yml` is the test composition; a deployment overlay must also set Connection's `multiuser: true` and restrict host-execution tools until sandbox isolation exists.

Provision accounts with the instance stopped before exposing it. The repository maintenance command creates one account in a JSON storage root; it reads the password from a hidden TTY prompt or `DSH_MULTIUSER_PASSWORD`, stores only the scrypt digest, and refuses an existing name:

```sh
pnpm exec tsx scripts/multiuser-provision.ts --storage-root "$DSH_HOME/storages" --username alice
```

`MultiuserService.provisionUser(username, password)` is the equivalent in-process step. Existing users are never overwritten and passwords are not reset at startup. Disabling an account writes `disabledAt` and revokes every login it holds.

<a id="workspace-creation"></a>
## Workspace creation

A user's `workspace/create` carries only an optional `title`; the service allocates an unpredictable directory below `workspaceRoot`, registers it, then commits the ownership row. A failed ownership commit withdraws the registration and removes the new empty directory. A workspace without an ownership row is invisible to every user.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package authenticates browser requests, owns workspace ownership rows, and registers only Remote access policy without adding a prompt, tool, or session event.

#### KV Cache effect

No direct effect; login and ownership changes do not alter model requests.

## Known Limitations and Deferred Work

- File, attachment, export, terminal, settings, and exact Fetch routes remain closed to ordinary users until their ownership rules are implemented.
- Ordinary users cannot change global settings or default model selections.
- Process-level sandbox isolation remains a separate Docker/runner task. This service denies all tool execution, including tools loaded by agent presets, until that integration exists.
- Self-service registration, password recovery, OAuth/OIDC, sharing, and user API keys are out of scope.
- Browser acceptance uses the real Web Loader composition in `apps/web/tests/multiuser.e2e.ts`; backend tests exercise login lifecycle, durable ownership, and rejection before dispatch.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Login state is loaded before the HTTP listener admits requests, so admission stays synchronous. Ownership rows and session membership are indexed in memory and refreshed from committed `domain/changed` values; they do not trust request JSON fields. New Remote actions must be added to the policy only after declaring every resource they touch in their method descriptor; an auxiliary anchor or lookup id that no reader names is not authorized.

</details>
