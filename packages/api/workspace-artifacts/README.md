---
description: "Authorized workspace listings and binary downloads."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-workspace-artifacts

English | [中文](README.zh.md)

## Summary

Lists and downloads regular files retained in an authorized registered workspace. This optional Linux provider keeps file access independent of sandbox lifetime, rejects symlinks and Host paths, and bounds listing metadata and browser download memory. The workspace composer supplies the file browser only while the provider is mounted.

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

Load the [file guide and opt-in overlay](../../../docs/user/workspace-artifacts.md) through a Web profile. The provider requires Connection, Remote Access, Typert, Workspace Controller and Workspace Registry. Default profiles do not enable it.

| Config | Default | Meaning |
|---|---|---|
| `maxEntries` | `2000` | Maximum entries inspected in one directory scan, including omitted entries. |
| `maxDownloadBytes` | `33554432` | Inclusive byte cap for one complete download. |

`workspaceArtifacts/list({ workspaceId }, path, signal)` returns `{ path, entries, truncated, maxDownloadBytes }`. The path is relative to the registered workspace; the empty string lists its root. Each entry carries its exact `name`, `kind` (`file` or `directory`) and optional file `bytes`.

`GET /api/workspace/downloadFileBinary?workspaceId=…&path=…` serves one regular file as an attachment. An owner uses owner authority; each multiuser account needs the matching workspace ownership binding. Anonymous and unauthorized requests are refused before file access.

Paths use `/` between exact components. Absolute paths, drive prefixes, `.` or `..` components, empty interior components, backslashes, control bytes, components above 255 UTF-8 bytes and paths above 4095 UTF-8 bytes are refused. Symlinks and special files are omitted from listings and never downloaded.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Descriptor ownership and browser transfers</summary>

Every directory component opens through its parent descriptor with `O_DIRECTORY | O_NOFOLLOW`; the final file uses `O_NOFOLLOW | O_NONBLOCK` and must pass the regular-file check on its opened descriptor. Replacing a pathname cannot redirect that descriptor to a symlink target. The registered root has a trusted parent that sandbox users cannot replace.

Downloads stream the byte extent measured on the opened file during preflight. Authority and workspace registration are rechecked before and after each read. Request cancellation, Peer revocation and provider withdrawal close the file; provider teardown waits for all requests and response bodies to settle.

The Client exposes `workspaceArtifactFiles.listFiles` and `downloadFile` only while the provider is selected. It uses document-relative HTTP URLs, combines caller and provider cancellation, enforces the listing cap while buffering, and only hands a completely received Blob to the browser download manager. Temporary object URLs are revoked after the gesture.

Listing refusals use `workspace-artifact/failed` with a typed `reason`; HTTP failures return `{ ok: false, error: { reason } }`. Categories are `invalid-path`, `denied`, `not-found`, `not-regular`, `too-large`, `cancelled` and `io`. Internal causes stay in Host logs; the UI provides localized recovery copy and never saves partial bytes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [File browser guide](../../../docs/user/workspace-artifacts.md) — enable browsing and downloads.
- [Workspace registry](../../../docs/subsystems/workspace.md) — persistent workspace identity.
- [Multiuser ownership](../multiuser/README.md) — account access to workspaces.

-----

<a id="model-experience"></a>
## Model Experience

### Direct effects

#### What the model sees

The browser uses `workspaceArtifactFiles` to read workspace files. No tools, prompt sections or Session events are added.

#### Token effect

Zero; listing and downloading do not call a model.

#### KV Cache effect

None; file operations do not change a model request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Linux deployment** — descriptor paths require Linux and a trusted workspace parent. Sandbox lifecycle and mount provisioning remain deployment responsibilities.
- **Manual listing refresh** — scans report truncation at `maxEntries`; pagination and filesystem watching are deferred. Open subdirectories to narrow the listing.
- **Bounded complete downloads** — files above `maxDownloadBytes` are refused. The browser buffers a complete file before starting its download.
- **Concurrent writers** — downloads retain the opened inode and initial byte extent, without a filesystem snapshot. Concurrent writes can alter returned bytes; truncation fails the transfer.
- **Read-only browser** — symlink resolution, previews, archive creation, deletion, backup and recovery are outside this provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

[Storage tests](tests/storage.spec.ts) verify binary preservation, descriptor-pinned path replacement and cancellation. [Host tests](tests/artifacts.host.spec.ts) exercise the real Connection route. Browser acceptance uses the real Web Loader and two accounts.

</details>
