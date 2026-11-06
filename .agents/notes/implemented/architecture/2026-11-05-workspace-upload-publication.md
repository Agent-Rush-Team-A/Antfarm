# Agent Note: Exclusive workspace upload publication

Status: implemented

English | [中文](2026-11-05-workspace-upload-publication.zh.md)

## Problem

Workspace upload writes into a directory visible to sandbox processes. Writing a partial destination exposes incomplete bytes, and following a destination symlink can modify a different file. A lost response can occur after publication.

## Decision

The [upload provider](../../../../packages/api/workspace-upload/README.md) stages bounded bytes in a private sibling directory and publishes an exclusive hard link through the opened workspace descriptor. It syncs the file and published directory, preserves existing entries, and reports whether publication occurred even when later work fails. Deployment owns the trusted parent, shared filesystem and container group.

The [Peer access mechanism](2026-10-12-peer-principal-and-remote-access.md) retains owner-only exact routes by default. An explicitly registered metadata authorizer admits a resource-scoped route; its mutation handler rechecks authority before publication. Workspace upload is the first consumer. [Chat attachment upload](../feature/2026-08-26-generic-file-upload.md) retains its separate storage and lifetime contract.

## Verification

Storage tests check byte preservation, path and symlink confinement, exclusive collisions, cancellation and staging cleanup. Real Web acceptance checks owned-workspace access, visible outcomes, logout and unload. Container acceptance checks a non-root Bash process reading uploaded bytes and writing through the workspace group.

## Alternatives considered

Writing directly to the destination exposes partial content and complicates cancellation cleanup when the sandbox changes that entry. Renaming a staged file replaces an existing entry. A filename existence check followed by a write races another creator. Exclusive descriptor-anchored publication preserves the old file without these windows.

## Consequences

The provider requires Linux descriptor paths and a trusted sibling staging area on the same filesystem. Each upload owns its resources until cleanup settles; unload stops admission and drains active uploads. A lost response remains an unknown outcome, and a post-publication failure preserves the committed file.
