---
description: "Personal credentials stored as authenticated ciphertext and managed by the logged-in account."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-user-credentials

English | [中文](README.zh.md)

## Summary

Manage personal credentials through an authenticated browser API. The Host stores ciphertext in the `user_credentials` storage domain; workspace ownership never grants credential access. This package requires the multiuser composition and a persistent private master-key file. Antfarm's [default Web entry](../../../docs/user/guide/personal-models.md) connects the credential UI, a Vultr catalog and request authorization.

## Table of Contents

- [Use this package](#use-this-package)
- [API behavior](#api-behavior)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Set `DSH_HOME` to the private Host data directory, then provision a key once outside the configured workspace root:

```sh
pnpm exec tsx scripts/user-credentials-key.ts --path "$DSH_HOME/secrets/user-credentials.key"
```

The command exclusively creates a private 32-byte file and refuses existing paths. Back up the key securely with the encrypted store. `initializeKeyIfEmpty` defaults to false; when enabled, a missing file is created only if the persisted credential table is empty. Existing files are never replaced. Missing keys for nonempty stores, unsafe file permissions, and ciphertext that cannot be authenticated refuse service startup; restore the original key and storage.

Mount the plugin after account authentication is configured:

```yaml
- insert:
    - id: user-credentials
      name: '@deepseek-ai/dsh-api-user-credentials'
      config:
        encryptionKeyFile: /absolute/private/secrets/user-credentials.key
        maxCredentialBytes: 16384
        maxRecordsPerUser: 64
- id: ui-user-credentials
  disabled: false
```

`maxCredentialBytes` bounds UTF-8 secret bytes; `maxRecordsPerUser` bounds account records, including concurrent creates. The record name is nonempty and at most 128 characters. The key path must be outside workspace mounts, including when parent directories contain symbolic links. Storage must also be routed to a private Host directory outside workspace mounts. The multiuser test overlay reads the key path from `DSH_USER_CREDENTIALS_KEY_FILE`.

<a id="api-behavior"></a>
## API behavior

The `userCredentials` Remote namespace lists safe metadata, creates credentials, replaces their values, removes records, and checks stored ciphertext. Its caller comes exclusively from the authenticated invocation. Unknown and foreign record IDs return the same `user-credentials/not-found` failure. Owner Peers and calls without a user invocation are rejected. Queued operations recheck request and login lifetime before running.

Responses contain only ID, name, configured state and timestamps. Checks authenticate and decrypt a caller-owned record in Host memory, then clear the plaintext buffer; they confirm storage readability, not authorization with an external service. Neither plaintext nor secret fragments enter domain or browser events, model messages, execution environments or workspace files. Errors carry fixed messages and empty details without raw storage or cryptographic causes.

An optional `inferenceBindings` array binds each pi-ai provider to an exact `baseURL` and account-local `credentialName`. Configure the pi-ai route with `credentialScope: request`; it never falls back to deployment keys, including when the consumer is unloaded. For example, bind provider `vultr`, endpoint `https://api.vultrinference.com/v1` and name `Vultr API Key`, then configure its `openai-completions` route and chosen model. HTTPS is required; `allowLoopbackHttp` permits only explicitly configured local test providers. Model catalogs expose configured metadata without reading credentials; authorization happens only at inference. Inference captures the authenticated prompt principal at the current turn, rejects mixed-account input, and rechecks live Session ownership before decrypting. Calls without a live authorized turn, duplicate matching names, and endpoint changes are refused. The Host-only credential waterfall is not forwarded to the browser; only the selected transport receives the secret. Saving, replacing and deleting bound credentials publish only model-catalog invalidation metadata.

Saving or replacing a bound credential refreshes its opt-in public model directory before notifying selectors. `refreshModels` accepts only an owned credential ID and an optional `force` retry; callers cannot supply an endpoint or another account. The result reports directory status and model count without decrypting the credential. A directory failure preserves a committed credential and does not claim that its key is valid.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

AES-256-GCM authenticates each record's user ID, record ID and encryption version, using a fresh 12-byte nonce for each write. Encryption precedes domain persistence, so `domain/changed` carries ciphertext. One service-owned write chain serializes quota checks and mutations; disposal refuses queued work, drains accepted writes, closes the domain and clears the key buffer. The global `ctx.credentials` provider remains independent.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Multiuser accounts](../multiuser/README.md) — authentication and login revocation.
- [Personal credential UI](../../client/ui-user-credentials/README.md) — browser entry and form behavior.

<a id="model-experience"></a>
## Model Experience

None, as the optional inference consumer changes transport authentication without adding model tools, prompt sections or request messages.

#### KV Cache effect

None; credential management never changes a model request prefix.

## Known Limitations and Deferred Work

- Inference supports explicitly bound pi-ai routes, not a general external-request proxy or credential-sharing grant. Subagents and autonomous calls without their own authenticated prompt are refused. Master-key rotation requires a separately designed migration; replacing the file prevents existing ciphertext from being read. Labels are user-supplied metadata and must not contain secrets. Confidentiality assumes the Host and its private storage remain trusted.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

None.

</details>
