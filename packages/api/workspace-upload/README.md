---
description: "Authorized streaming uploads into registered workspace directories."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-workspace-upload

English | [中文](README.zh.md)

## Summary

Uploads browser files into the root of an authorized registered workspace. The optional Linux Host service checks resource access, bounds streamed bytes, and preserves existing files.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Load the [opt-in upload overlay](../../../apps/cli/config/examples/workspace-upload.patch.yml) through a Web profile. It requires Connection, Remote Access, Typert, Workspace Controller and Workspace Registry. It is absent from default profiles.

| Config | Default | Meaning |
|---|---|---|
| `maxBytes` | `33554432` | Positive safe integer; inclusive maximum bytes per file. |

`workspaceUpload/limits({ workspaceId })` returns the byte limit. Send raw bytes with `Content-Type: application/octet-stream` to `POST /api/workspace/uploadFileBinary?workspaceId=…&name=…`. Neither request accepts a host path. Owner-local calls use owner authority; multiuser accounts require the workspace ownership binding. Anonymous calls and other workspaces are denied.

Names are single leaves of at most 255 UTF-8 bytes. Directory separators, control characters, drive prefixes, blank names, `.` and `..` are refused. Empty files are allowed. Existing files, directories and symlinks return `exists`; rename the selected file before retrying.

<a id="understand-the-implementation"></a>
## Understand the implementation

The service opens the trusted registered root without following its final symlink, stages bytes in a private sibling directory, checks the size during streaming, and syncs the file before publishing an exclusive hard link through the open directory descriptor. It rechecks permission and workspace registration before publication. The deployment must keep the workspace parent trusted and place staging on the same filesystem.

The published file inherits the workspace directory's group and uses mode `0660`. Provision the workspace directory's group and access for the non-root sandbox account as described in [Runner deployment](../../../team-docs/SANDBOX-RUNNER.md). File upload does not create or configure a sandbox.

Success returns `{ ok: true, value: { name, bytes } }` after cleanup. Failures return `{ ok: false, error: { reason, stored } }`; internal paths and causes stay in Host logs. `stored` becomes true only after publication. A cleanup failure can therefore report a committed file. The browser reports lost confirmations as unknown and asks the user to check the workspace before retrying. Existing entries are never replaced.

The Client provider exposes `ctx.workspaceUploads.uploadFile(workspaceId, file, signal)` only while this plugin is mounted. Limit reads and byte transfers share caller and provider cancellation. Cancellation during the limit read returns `cancelled` before sending bytes, including when the Gateway returns a failure result. The document-relative HTTP route preserves deployment URL prefixes. Browser withdrawal aborts and drains its transfers.

Every operation owns its descriptors and staging directory. Disconnect, peer revocation and service unload cancel blocked body reads; unload drains admitted operations before releasing the provider. A cancellation racing successful publication does not remove the committed file.

<a id="model-experience"></a>
## Model Experience

### Direct effects

#### What the model sees

`workspaceUploads.uploadFile` adds no tools, prompt sections or attachment messages. Existing workspace tools can read uploaded files from the mounted directory.

#### Token effect

Zero from upload itself. Subsequent tool reads incur their normal cost.

#### KV Cache effect

Independent. Upload does not change the model request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Linux descriptor paths are required. The trusted parent must not be writable by sandbox users, and staging must share the workspace filesystem.
- Upload is limited to one file in the workspace root; directory upload, replacement, listing and download are outside this service.
- Deployment owns workspace directory provisioning, aggregate disk quotas and sandbox mounting. Per-file limits do not provide aggregate storage quotas.

<a id="dev-note"></a>
### Dev Note

[Storage tests](tests/storage.spec.ts) exercise binary preservation, collisions, path replacement, limits and cleanup. [Host route tests](tests/upload.host.spec.ts) exercise real Connection admission, streamed bodies and owned-workspace authorization.
