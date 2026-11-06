---
description: "Workspace sandbox observations and authenticated management through Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-sandbox

English | [中文](README.zh.md)

## Summary

Workspace sandbox resources observe the current workspace without opening a container. Mutations use the authenticated Harness management API and never select host paths or containers.

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

Enable this plugin with the [Harness sandbox overlay](../../../apps/cli/config/examples/harness-sandbox.patch.yml). The independent Runner and canonical workspace root are deployment prerequisites. `pollIntervalMs` is the delay after a completed status query; its default is 2000 milliseconds.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

The workspace resource is `dsh-resource://workspacesandbox/<workspaceId>`. Its provider shares one polling loop among holders and stops when the last holder leaves. Submitted open and close requests remain owned until settlement or connection loss. Mutations are never retried automatically.

A failed query retains the last observed state with a failure. Connection replacement discards old observations and repulls; delayed old responses cannot overwrite the new generation. Failure reports use stable reasons and exclude raw diagnostics.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Harness sandbox management](../../sandbox/harness-sandbox/README.md) — authenticated lifecycle operations.

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

None.

</details>
