---
description: "Use the default Antfarm model catalog with credentials owned by your account."
kind: "user-guide"
---

# Personal model credentials

English | [中文](personal-models.zh.md)

## Choose a model

Start Antfarm with `pnpm run start:web` or `pnpm run dev:web` after the [first account setup](../../../README.md#run-from-source). Sign in, open a conversation, and choose a model under Vultr. The [default deployment configuration](../../../apps/cli/config/antfarm-web.patch.yml) supplies the model directory; models remain visible before you save a key and after you delete one. Visibility confirms configured metadata, not access to the external service.

## Save your credential

Open **My credentials** in the sidebar. Enter the exact name `Vultr API Key`, paste a key authorized for Vultr Cloud Inference, and save. Submit a short message using a Vultr model. Calls go to `https://api.vultrinference.com/v1` and use only the initiating account's saved credential. An account without that credential receives a configuration prompt; it cannot use a deployment key or another account's key.

Store one credential with that name per account. Use **Replace value** to update it and **Delete** to remove it. Duplicate matching names are rejected at inference; remove the duplicate and retry. **Check storage** confirms that the server can decrypt the saved value, without testing service authorization. A rejected API key requires updating the credential or checking inference access. Rate limits and service outages require retrying later; persistent service failures require administrator help. Cloud instance management access alone does not establish inference access.

## Retain deployment data

For an empty deployment, Antfarm creates a private 32-byte master-key file at `$DSH_HOME/secrets/user-credentials.key`. Restarts reuse it. Back up that file with `$DSH_HOME/storages/user_credentials.json` and the account data. Keep the key and storage outside workspace mounts. A missing key with saved ciphertext, an unsafe key file, or unreadable ciphertext refuses credential service startup; restoring the original key is required.

To supply an externally managed key, set `DSH_USER_CREDENTIALS_KEY_FILE` to its absolute path before starting. That file must already exist; see [key provisioning](../../../packages/api/user-credentials/README.md#use-this-package). Never replace the key independently of its encrypted store. Key rotation is not supported.

## Configure the directory

The first supported personal provider is Vultr. Its explicit catalog is deployed in [antfarm-web.patch.yml](../../../apps/cli/config/antfarm-web.patch.yml), using the [Vultr public directory](https://api.vultrinference.com/v1/models) as the source. Saving credentials does not discover providers or synchronize models. The shipped catalog exposes text input and bounds responses to 8192 tokens per model.

Administrators can replace the `llm-pi-ai` provider configuration through a later patch. Retain `credentialScope: request`, and update the [personal credential binding](../../../packages/api/user-credentials/README.md#api-behavior) if changing the provider, endpoint, or credential name. An endpoint that differs from the binding is refused. Match model IDs and capabilities to the provider's current directory before deploying changes.
