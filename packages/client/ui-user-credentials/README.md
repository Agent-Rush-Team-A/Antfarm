---
description: "A private credential form available independently of global settings permissions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-user-credentials

English | [中文](README.zh.md)

## Summary

Open **My credentials** from the sidebar footer to manage the logged-in account's credentials. Enable this plugin with the Host personal-credential API. The entry follows `userCredentials/list` permission without requiring global settings access.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle supplies a disabled `ui-user-credentials` row. Antfarm's [default entry](../../../docs/user/guide/personal-models.md) enables it together with the [Host plugin](../../api/user-credentials/README.md); other multiuser compositions must enable both. Add a named credential, replace its value, check storage readability or confirm deletion. The dialog explains that workspace sharing does not share credentials and a storage check does not authenticate an external service.

The name field asks for the service's configured credential name, such as `Vultr API Key`. The value field asks for the secret itself and explains that Vultr requires Cloud Inference access. Persistent hints remain visible while typing. Configured models are visible before a credential is saved; Host inference bindings use the current account's credential when calling the selected provider and model.

Credential values use a password input. Submission clears that input before the request; responses never refill it. Closing, disconnecting, access revocation and switching accounts discard the dialog. No form or credential list is written to browser storage. A failed request shows localized fixed copy rather than displaying raw exceptions.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

The plugin mounts the personal-credential Remote definitions, registers `sidebar.footer.action` through the slot registry and renders the shared Modal primitive. Private dialog state owns metadata, selection and request lifetime; the secret remains in an uncontrolled input until submission. Abort signals cancel dialog-owned requests and prevent late responses from updating closed UI. All text belongs to the typed `userCredentials` dictionary.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Personal credential Host](../../api/user-credentials/README.md) — ownership checks and encrypted persistence.
- [Sidebar slots](../ui-sidebar/README.md) — the footer registration.

<a id="model-experience"></a>
## Model Experience

None, as this browser plugin contributes no model tools, messages or Session events.

#### KV Cache effect

None; opening the form does not change model requests.

## Known Limitations and Deferred Work

- The page does not reveal or export saved values and does not validate external authentication. Inference requires an explicit [Host binding](../../api/user-credentials/README.md). Lists refresh on entry and after operations; another tab's changes require Refresh.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

None.

</details>
