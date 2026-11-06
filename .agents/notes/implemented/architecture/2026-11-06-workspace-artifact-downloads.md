# Agent Note: Descriptor-pinned workspace downloads

Status: implemented

English | [中文](2026-11-06-workspace-artifact-downloads.zh.md)

## Problem

Workspace processes can replace paths between validation and opening. Browser downloads must not expose files outside the authorized workspace, and closing a sandbox must not remove access to retained task outputs.

## Decision

The [artifact provider](../../../../packages/api/workspace-artifacts/README.md) owns a separate read-only capability addressed by workspace identity. It opens each directory through its parent descriptor, refuses symlinks at every component, and checks the final opened descriptor is a regular file. The registry root has a trusted parent. Download authority and workspace registration are rechecked before and after each chunk.

Downloads retain the initial byte extent of the opened inode and transfer through an authenticated HTTP stream. Requests and response bodies remain owned through descriptor cleanup; provider withdrawal aborts and drains both. The browser applies the deployment cap while buffering and only saves a completely received Blob.

The [Session preview read-authority decision](2026-09-09-workspace-file-read-authority.md) remains active for the existing preview service. The artifact capability has workspace containment and workspace ownership rather than inheriting the broader Session filesystem read policy. The [upload publication decision](2026-11-05-workspace-upload-publication.md) continues to own writes.

## Alternatives considered

A resolved-path prefix check followed by an ordinary open races path replacement. Following symlinks requires stronger kernel path-resolution support. This provider rejects symlinks and pins each directory instead. Reusing the preview endpoint would inherit its outside-workspace read policy.

Handing a URL directly to the browser download manager gives the app no reliable failure result. A bounded complete Blob makes permission, size and transfer failures visible without saving partial files.

## Consequences

Linux descriptor paths and a trusted workspace parent are required. Symlinks and special files are omitted. Listings are capped and manually refreshed; downloads have a configurable byte cap and do not provide filesystem snapshots, previews, backup or recovery. Sandbox lifecycle is independent.

Deterministic replacement tests cover directory swaps, pre-open leaf swaps and post-open replacements. Real Connection tests cover authorization and unconsumed-body teardown; real Web acceptance covers two accounts, deployment prefixes and files retained after a container exits.
