# Agent Note: Personal credentials belong to the request initiator

Status: implemented

English | [中文](2026-11-06-personal-credentials.zh.md)

## Problem

The global credential provider resolves names for all Harness consumers and falls back to deployment environment values. Giving ordinary accounts write access to it would let one account replace another account's credentials or the inference key. Workspace membership cannot identify who owns a personal credential or who initiates a later external-service request.

## Decision

The personal-credential plugin owns a separate encrypted domain and browser API. Each operation derives the account from the authenticated invocation, checks record ownership in the operation itself and refuses owner or absent user identities. The [Host README](../../../../packages/api/user-credentials/README.md) owns storage and failure semantics.

Encryption precedes the domain write because domain events carry record values. AES-GCM binds ciphertext to the account, record ID and version. The key is explicitly provisioned outside workspace mounts and is never regenerated when missing. Only safe metadata crosses read responses. A backend storage check exercises authorized decryption without releasing plaintext or implying external-service authorization.

## Alternatives considered

**Expose the existing credential namespace.** Its flat references and environment fallback are deployment-wide. Opening it to ordinary users changes global provider behavior and cannot enforce personal ownership.

**Prefix global names with user IDs.** Naming conventions do not authorize access, and arbitrary global-store consumers still resolve those values. An independent store makes the separation an implementation property.

## Consequences

Storage checks remain local, no generic external-request proxy is provided, and workspace sharing provides no credential grant. Key rotation requires an explicit migration, and losing the master key makes encrypted records unavailable. Names remain non-secret metadata supplied by the user.

## Verification

Host tests exercise two accounts with same-named credentials, cross-account mutations and decryption checks, encryption ownership binding, restart readability, key failures, quotas and request revocation.
