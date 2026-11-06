# Agent Note: Personal credentials belong to the request initiator

Status: implemented

English | [中文](2026-11-06-personal-credentials.zh.md)

## Problem

The global credential provider resolves names for all Harness consumers and falls back to deployment environment values. Giving ordinary accounts write access to it would let one account replace another account's credentials or the inference key. Workspace membership cannot identify who owns a personal credential or who initiates a later external-service request.

## Decision

The personal-credential plugin owns a separate encrypted domain and browser API. Each operation derives the account from the authenticated invocation, checks record ownership in the operation itself and refuses owner or absent user identities. The [Host README](../../../../packages/api/user-credentials/README.md) owns storage and failure semantics. The browser entry is enabled explicitly with the multiuser deployment and uses its own form, independent of global settings access.

Encryption precedes the domain write because domain events carry record values. AES-GCM binds ciphertext to the account, record ID and version. The key is explicitly provisioned outside workspace mounts and is never regenerated when missing. Only safe metadata crosses read responses. A backend storage check exercises authorized decryption without releasing plaintext or implying external-service authorization.

## Alternatives considered

**Expose the existing credential namespace.** Its flat references and environment fallback are deployment-wide. Opening it to ordinary users changes global provider behavior and cannot enforce personal ownership.

**Prefix global names with user IDs.** Naming conventions do not authorize access, and arbitrary global-store consumers still resolve those values. An independent store makes the separation an implementation property.

**Put the page in global settings.** The settings shell requires permission to describe global configuration. A dedicated footer entry preserves the existing restricted multiuser policy.

## Consequences

Explicit pi-ai inference bindings authorize the current turn's authenticated prompt principal before decrypting an account-local named credential; exact endpoints are allowlisted and request-scoped routes never fall back to deployment keys. Storage checks remain local, no generic external-request proxy is provided, and workspace sharing provides no credential grant. Key rotation requires an explicit migration, and losing the master key makes encrypted records unavailable. Names remain non-secret metadata supplied by the user.

## Verification

Host tests exercise two accounts with same-named credentials, cross-account mutations and decryption checks, encryption ownership binding, restart readability, key failures, quotas and request revocation. Component tests exercise password clearing, fixed failure copy, deletion confirmation and dialog cancellation. The multiuser Web scenario drives the real Loader composition, calls an OpenAI-compatible fixture with each account’s own credential, rejects a deleted credential and records the dialog with secrets absent from request bodies and Session events.
