---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-multiuser-principal

English | [中文](2026-11-06-multiuser-principal.zh.md)

## Summary

Adds authenticated account and anonymous principal alternatives to user-RPC message attribution in queued input, developer messages, title requests, and user messages. The Session format remains V4.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-multiuser-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "b49d167cab355d5faf19669680949a7d9d3907b35d6806fa6651070102aaab0b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "0058003839d781cd15fc9aafaf3f68229475a88d05b7ca4c9d6fcd817f3e11b7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "9119ff885a4ca0831555d8f68a789dc7150de08d899872e25225a040bc2badd3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "fa2b07fdc2163ef2432958e63f6e4c28a1bd13f2945478ab4e679c228177d476"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All previous principal alternatives remain valid, and owner prompts still omit principal. New readers therefore retain historical attribution and behavior. Older V4 readers preserve the additional principal JSON: native source admission checks the existing user source kind without interpreting principal alternatives, and reading does not turn persisted attribution into a live Peer or an authorization grant. The account principal records only kind and userId, without credentials. The anonymous alternative is declared for connection admission; unauthenticated business RPCs are refused before dispatch. Live access decisions continue to use the admitted Peer and current workspace ownership rather than persisted message attribution. No migration or writer version increase is required.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts --maxWorkers=1: 54 tests passed. The unchanged V4 reader preserves historical owner, account, and anonymous attribution without account services in read/write and plain/zstd modes, leaving stored bytes unchanged. DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/multiuser.e2e.ts: passed; an authenticated prompt records the account principal, unauthenticated requests and cross-account access are rejected, and logout invalidates the old cookie.

<a id="dev-note"></a>
## Dev Note

None.
