---
description: "Workspace sandbox observations and authenticated management through Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-sandbox

English | [中文](README.zh.md)

## Summary

View sandbox status and start or stop a workspace's sandbox from the browser. Enable this package with Harness management and a local Runner or the Vultr backend. An open panel polls status every two seconds by default; only explicit user actions open or close a sandbox.

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

The Web bundle includes this plugin disabled by default. Enable it through the [Runner overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml) or [Vultr overlay](../../../apps/cli/config/examples/harness-vultr.patch.yml), with that backend’s deployment prerequisites and canonical workspace root. `pollIntervalMs` is the delay after a completed status query; its default is 2000 milliseconds.

The workspace menu and conversation input action open the same panel for the selected workspace. It displays current state, prevents repeated pending operations, refreshes explicitly and asks for confirmation before closing. Dismissing the panel leaves the sandbox running.

Capacity exhaustion asks the user to close a sandbox or retry later. Unknown operation results disable new mutations; a failed status query marks the last observed state as stale. Workspace access revocation removes the panel and menu entry, and connection replacement or plugin disposal suppresses delayed feedback.

Cloud startup failures request a status refresh before retrying; unsafe closure failures request administrator assistance before reopening.

| Field | Default | Meaning |
| --- | --- | --- |
| `pollIntervalMs` | `2000` | Delay after a completed status query, in milliseconds. |

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

The workspace resource is `dsh-resource://workspacesandbox/<workspaceId>`. Its provider shares one polling loop among holders and stops when the last holder leaves. Submitted open and close requests remain owned until settlement or connection loss. Mutations are never retried automatically.

A failed query retains the last observed state with a failure. Connection replacement discards old observations and repulls; delayed old responses cannot overwrite the new generation. Failure reports use stable reasons and exclude raw diagnostics.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Web sandbox guide](../../../docs/user/guide/workspace-sandboxes.md) — deployment and browser controls.
- [Harness sandbox management](../../sandbox/harness-sandbox/README.md) — authenticated lifecycle operations.
- [Runner deployment](../../../team-docs/SANDBOX-RUNNER.md) — the independent Docker service.

<a id="model-experience"></a>
## Model Experience

None, as browser sandbox management contributes no model tools, messages or Session events.

#### KV Cache effect

None; querying sandbox status does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Unknown mutation results remain visible. The Harness closing barrier requires deployment maintenance; the browser cannot establish cleanup from one closed observation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Browser acceptance is owned by `apps/web/tests/workspace-sandbox.e2e.ts`. Set `DSH_SANDBOX_UI_DOCKER_SOCKET` and `DSH_SANDBOX_UI_DOCKER_IMAGE` (a preloaded digest-pinned Runner image) to run the same scenario against a real independent Runner. Without these deployment inputs, the scenario uses a controlled Runner to hold progress states and inject status failures.

</details>
