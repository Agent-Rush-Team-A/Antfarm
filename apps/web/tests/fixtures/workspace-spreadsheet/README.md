# Real cloud spreadsheet acceptance

English | [中文](README.zh.md)

This opt-in browser scenario runs the shipped Antfarm Web profile, real Vultr DeepSeek inference and independent Workspace VMs. It covers the spreadsheet workflow tracked by issue #12 using the cloud migration from issue #26.

## Prerequisites

Build the checkout and its standalone SSH helper. Supply a private Vultr deployment JSON as `DSH_VULTR_TEST_CONFIG` and a private inference-key file as `DSH_VULTR_INFERENCE_KEY_FILE`. The inference key must authorize `chat/completions` for the selected model; a successful model-directory query is insufficient. The deployment JSON follows the [Vultr guide](../../../../../docs/user/guide/workspace-vultr.md); its SSH key and helper must remain available throughout the run. Chromium must be installed for the repository's Playwright dependency.

The independent timeout check requires Python 3 on the Linux VM and uses the provider's pinned OpenSSH configuration. Its keyless process regression also requires Python 3 on the local Linux host.

The scenario creates at most two paid VMs and their snapshots. It provisions a disposable account and private data directories, selects a unique deployment identifier, and deletes only that deployment's cloud resources during teardown. The shared preview and existing accounts are not used.

## Run

```sh
DSH_VULTR_TEST_CONFIG=/private/deployment.json \
DSH_VULTR_INFERENCE_KEY_FILE=/private/inference.key \
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-spreadsheet.e2e.ts
```

The file skips without both inputs. A skipped run is not acceptance evidence. Snapshot creation and restoration can take several minutes; the scenario allows two hours and does not retry paid operations automatically.

## Inputs and assertions

Only `sales.csv` is uploaded, as `销售明细.csv`. It contains completed sales, negative-quantity returns and a cancelled order. The model receives the aggregation rules through the real composer and uses Bash to create `月度汇总.csv`. Months use `YYYY-MM`; CSV cells are compared independently of standard quoting and line endings. The independently specified `monthly.expected.csv` remains outside every model Workspace. Its three monthly amounts are 348.40, 976.40 and 394.70; the annual total is 1,719.50 across nine included records and sixteen net units.

The browser downloads and compares the monthly output, creates a second Session to continue from that file, checks a second Workspace's isolation, confirms a command timeout and subsequent process cleanup, and opens a third Workspace to observe the full-capacity message. It then closes and restores the first Workspace, compares original and downloaded bytes, and asks the real model to continue after restoration.

The timeout command records its shell and child PIDs, then waits for a 24-hour child process, longer than the entire two-hour acceptance budget. The Session log must show the specified command, a one-second Bash timeout and no further model tool call in that turn. The Host independently checks both PIDs through SSH and `/proc`, allowing up to five seconds for termination and ten seconds for the whole SSH operation. A missing or malformed PID record, surviving process, or failed check rejects the acceptance; the result is saved as `timeout-process-check.json`. Terminated zombies are distinguished from processes that can still execute.

The run uses a ten-minute idle threshold and a one-second sweep. After the second Workspace finishes its task, it receives no more execution or file activity while the first Workspace is saved and restored. The browser then checks that the second Workspace was automatically closed and its file remains downloadable. This override tests the configured policy; it does not measure the default thirty-minute interval. The official browser directory-picker overlay is enabled.

## Evidence

Each run writes screenshots, accessible-page snapshots, raw browser videos, downloaded outputs, steps, a final result and Session logs under the gitignored `.playwright-mcp/issue12-*` directory. The test reports its exact evidence directory. A completed acceptance run requires a zero test-process exit status, `result.json` with `success: true`, and confirmed cloud cleanup. Failed runs remain diagnostic evidence and must not be combined into a successful recording.

Teardown attempts every discovered VM and snapshot deletion even when another deletion fails. A failed inventory does not prevent cleanup of the other resource kind; both final inventories are checked independently. Every cleanup failure remains in `result.json` and fails the run. Keyless fault injection and real local process checks run with `pnpm exec vitest run apps/web/tests/workspace-spreadsheet-support.spec.ts`.

The browser uses an isolated headless Playwright context when no browser-control connector is available. The shared launcher starts the built Web profile under plain Node. Personal inference credentials are provisioned through the authenticated production API before any model request. No model or cloud transport is replaced. Raw video is retained as WebM; GIF encoding additionally requires the media tools documented by the repository's recording skill.
