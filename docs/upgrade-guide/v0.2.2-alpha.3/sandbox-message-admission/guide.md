---
kind: upgrade-guide
description: "The optional workspace sandbox overlay now prepares messages and keeps reopening blocked after uncertain mutations."
---

# Sandbox message admission and closing

English | [中文](guide.zh.md)

## Change

The optional `harness-sandbox.patch.yml` overlay now prepares the sandbox before accepting an authenticated workspace message. Runner failure can therefore refuse a prompt. Closing cancels active and queued input in every Session of that workspace; ordinary Session stop still preserves queued input.

The overlay replaces the standard Agent preset with foreground Runner Bash and its persona, disables other shipped presets and host/indirect tools, and selects native execution. The multiuser default denial remains, with an exception bound to the exact Runner definition, admitted step and original message permission. Working Directory displays `/workspace`; host path-transition notices, host file-policy context and development/file-delivery guidance are omitted. Backend directory records keep their actual paths.

New opens fail during closure. Previously a later query could observe completion after a lost mutation response; now an uncertain PUT or DELETE keeps local status at `closing`, including after plugin reload and another DELETE. The protocol cannot prove that the older request has settled. Files and Session format are unchanged.

## Migration

1. Keep the deployment variables in the [workspace sandbox guide](../../../user/guide/workspace-sandboxes.md). The overlay now also loads `@deepseek-ai/dsh-harness-sandbox/conversation`; custom compositions that need automatic preparation must include that entry with the native Session Controller and Agents.
2. Treat prompt preparation failures as rejected submissions. Retry with the same `requestId`; cancelled, never-admitted IDs remain cancelled for the Harness process lifetime. Submit intentional new work with a new ID.
3. Handle `closing` and failed close explicitly. Retry a confirmed refusal through `workspaceSandbox/close`, without queuing an open. For `outcomeUnknown: true`, keep the workspace blocked and establish settlement through deployment maintenance; a single query or restarting Harness does not establish this. See [limitations](../../../../packages/sandbox/harness-sandbox/README.md#known-limitations-and-deferred-work).
4. Verify that an owned message prepares its sandbox and that closing clears active and queued input. A fresh message after confirmed close may open a new generation; an old accepted ID must not reopen or requeue.
5. Keep the overlay's preset and native-executor changes, `working-directory.config.modelDirectory: /workspace`, `sandbox-policy.config.modelContext: false` and `spill-policy.disabled: true`. Confirm actual model requests advertise only Runner Bash and contain no host workspace path; management must still address the saved host workspace. Custom presets must mount the isolated Bash entry rather than a same-name host tool. Large results must retain the Runner tails without a host spill-file recovery instruction.
