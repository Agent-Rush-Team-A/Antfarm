---
description: "Use the default Antfarm model catalog with credentials owned by your account."
kind: "user-guide"
---

# Personal model credentials

English | [中文](personal-models.zh.md)

## Choose a model

Start Antfarm with `pnpm run start:web` or `pnpm run dev:web` after the [first account setup](../../../README.md#run-from-source). Sign in, open a conversation, and choose a model under Vultr. The [default deployment configuration](../../../apps/cli/config/antfarm-web.patch.yml) loads Vultr's public model directory; models remain visible before you save a key and after you delete one. Visibility confirms advertised capabilities, not access to the external service.

## Save your credential

Open **My credentials** in the sidebar. Enter the exact name `Vultr API Key`, paste a key authorized for Vultr Cloud Inference, and save. Saving loads the bound model directory and displays the available model count. Choose a Vultr model in the conversation and submit a short message. Calls go to `https://api.vultrinference.com/v1` and use only the initiating account's saved credential. An account without that credential receives a configuration prompt; it cannot use a deployment key or another account's key.

Use **Refresh models** to fetch the current directory immediately. If discovery fails, the credential stays saved and the last successful directory remains available; the dialog offers a retry and identifies cached results. Loading the public directory sends no credential and does not validate the key's inference permissions.

Store one credential with that name per account. Use **Replace value** to update it and **Delete** to remove it. Duplicate matching names are rejected at inference; remove the duplicate and retry. **Check storage** confirms that the server can decrypt the saved value, without testing service authorization. A rejected API key requires updating the credential or checking inference access. Rate limits and service outages require retrying later; persistent service failures require administrator help. Cloud instance management access alone does not establish inference access.

## Retain deployment data

For an empty deployment, Antfarm creates a private 32-byte master-key file at `$DSH_HOME/secrets/user-credentials.key`. Restarts reuse it. Back up that file with `$DSH_HOME/storages/user_credentials.json` and the account data. Keep the key and storage outside workspace mounts. A missing key with saved ciphertext, an unsafe key file, or unreadable ciphertext refuses credential service startup; restoring the original key is required.

To supply an externally managed key, set `DSH_USER_CREDENTIALS_KEY_FILE` to its absolute path before starting. That file must already exist; see [key provisioning](../../../packages/api/user-credentials/README.md#use-this-package). Never replace the key independently of its encrypted store. Key rotation is not supported.

## Configure the directory

The first supported personal provider is Vultr. The [deployment patch](../../../apps/cli/config/antfarm-web.patch.yml) enables `modelDiscovery.type: vultr` on its pi-ai route. Discovery reads the [Vultr public directory](https://api.vultrinference.com/v1/models), retains ready models that support streaming text, tools and a known context limit, and maps their advertised reasoning and image-input capabilities. Responses are bounded to 8192 tokens or the model's lower output/context limit. Saving a credential with another name does not add a provider.

Discovery requests have a five-second timeout and a 4 MiB response limit. Concurrent requests share one refresh and successful results remain fresh for five minutes. The public catalog is retained at `$DSH_HOME/cache/vultr-model-catalog.json` for restarts. A failed refresh preserves the last successful result; when no usable cache exists, the three deployment presets remain available. Set `modelDiscovery: false` to use only the configured catalog; see the [adapter configuration](../../../packages/llm/llm-pi-ai/README.md#use-this-package).

Administrators can replace the `llm-pi-ai` provider configuration through a later patch. Retain `credentialScope: request`, and update the [personal credential binding](../../../packages/api/user-credentials/README.md#api-behavior) if changing the provider, endpoint, or credential name. An endpoint that differs from the binding is refused. Match model IDs and capabilities to the provider's current directory before deploying changes.
