# RFC: Harness-Captured Evidence

**Author:** Sam Painter (samfoy)
**Date:** 2026-04-27
**Status:** Draft

## Problem

The autoloop harness today is a **passive scheduler**. It routes events between roles, enforces iteration limits, and records journal entries — but it never looks at what the agent actually did. All verification depends on one LLM role (the critic) reading another LLM role's self-reported summary (the scratchpad).

This creates three classes of failure that the harness cannot detect or prevent:

### 1. Silent structural damage

An agent deletes 400 lines of explicitly-requested code and describes it as "simplification" in the scratchpad. The critic reads the scratchpad, agrees, and emits `review.passed`. The harness sees a valid event and continues. Nobody checked the diff.

**Real example:** During the `ap` Rust project build, Ralph's builder autonomously deleted the entire Rhai + libloading extension system that the user had explicitly requested via two design amendments. The monitor agent detected the violation post-facto but had no mechanism to prevent it. Twenty minutes of compute wasted.

### 2. Unverifiable claims

The builder writes "all tests pass" in the scratchpad. The critic reads this claim and accepts it. Neither the harness nor the critic actually ran the tests. The builder may have run them and seen failures it chose not to mention, or it may not have run them at all.

### 3. Invisible regressions

Iteration 5 introduces a type error that breaks compilation. The builder in iteration 6 works around it with a cast. The critic in iteration 6 reviews the cast and finds it reasonable. Nobody noticed the underlying regression because the harness doesn't capture diagnostics between iterations.

## Root Cause

The harness treats the agent as a **trusted narrator**. The scratchpad is written by the agent, read by the agent, and evaluated by the agent. The harness never independently observes the state of the world.

This is the fundamental gap. The harness has full access to the filesystem, git, and the shell — it can observe everything. It just doesn't.

## Proposal

Add an **evidence capture layer** to the harness that runs automatically between iterations. The layer captures machine-readable ground truth about what changed, injects it into the next role's prompt, and optionally gates iteration transitions.

The key principle: **evidence is captured by the harness, not reported by the agent.**

## Design

### Evidence Sources

| Source | What it captures | When |
|--------|-----------------|------|
| `git-diff` | Unified diff of all changes since last iteration | After every iteration |
| `git-stat` | `--stat` summary (files changed, insertions, deletions) | After every iteration |
| `test-runner` | Exit code + stdout/stderr of a configured test command | After builder iterations |
| `type-check` | Exit code + output of a configured type-check command | After builder iterations |
| `lint` | Exit code + output of a configured lint command | After builder iterations (optional) |
| `custom` | Exit code + output of any user-configured command | Configurable per-role |

### Evidence Lifecycle

```
┌──────────────┐
│  Iteration N  │  (builder runs, edits files, writes scratchpad)
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│  Evidence Capture │  (harness runs git diff, tests, type-check)
│  (harness-owned)  │
└──────┬───────────┘
       │
       ├──► Journal: evidence stored as structured event
       │
       ├──► Gate check: if any gate fails, emit backpressure event
       │                 (iteration retried, not forwarded to critic)
       │
       └──► Prompt injection: evidence summary injected into
            iteration N+1's prompt as "Harness Evidence" section
```

### Evidence Capture Implementation

New module: `packages/harness/src/evidence.ts`

```typescript
export interface EvidenceSource {
  id: string;                          // e.g. "git-diff", "test-runner"
  command: string;                     // shell command to run
  timeout_ms: number;                  // max execution time
  roles?: string[];                    // only run after these roles (empty = all)
  gate?: boolean;                      // if true, non-zero exit blocks transition
  gate_on?: "exit_code" | "pattern";   // what constitutes failure
  gate_pattern?: string;               // regex — if matched in output, gate fails
  budget_chars?: number;               // max chars to inject into prompt
}

export interface EvidenceResult {
  source_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  elapsed_ms: number;
  gate_passed: boolean | null;         // null if not a gate source
}

export interface IterationEvidence {
  iteration: number;
  role: string;
  captured_at: string;                 // ISO timestamp
  results: EvidenceResult[];
  overall_gate_passed: boolean;
}
```

Evidence capture runs synchronously after the backend process completes but before event routing. This is a natural insertion point in `finishIteration()`:

```typescript
// In iteration.ts, finishIteration():

// 1. Backend finished, output captured
// 2. NEW: Capture evidence
const evidence = captureEvidence(loop, iter);
appendEvidenceEvent(loop, iter, evidence);

// 3. If any gate failed, emit backpressure instead of routing
if (!evidence.overall_gate_passed) {
  return handleGateFailure(loop, iter, evidence);
}

// 4. Existing: parse emitted event, route to next role
```

### Configuration

```toml
# In autoloops.toml

[evidence]
enabled = true

[[evidence.source]]
id = "git-diff"
command = "git diff --stat HEAD"
timeout_ms = 5000
# No roles filter — runs after every iteration
# No gate — informational only

[[evidence.source]]
id = "git-diff-full"
command = "git diff HEAD"
timeout_ms = 10000
budget_chars = 8000
# Full diff injected into critic prompt, truncated to budget

[[evidence.source]]
id = "test-runner"
command = "npm test 2>&1"
timeout_ms = 120000
roles = ["builder"]          # only run after builder iterations
gate = true                  # non-zero exit blocks transition to critic
gate_on = "exit_code"

[[evidence.source]]
id = "type-check"
command = "npx tsc --noEmit 2>&1"
timeout_ms = 60000
roles = ["builder"]
gate = true
gate_on = "exit_code"

[[evidence.source]]
id = "lint"
command = "npm run lint 2>&1"
timeout_ms = 30000
roles = ["builder"]
gate = false                 # informational, don't block on lint
```

### Prompt Injection

Evidence is injected into the next iteration's prompt as a structured section. This happens in `renderIterationPromptText()`:

```markdown
## Harness Evidence (iteration 4, role: builder)

> This evidence was captured by the harness, not reported by any agent role.
> Treat it as ground truth.

### git-diff (files changed)
 src/auth/login.ts   | 45 ++++++++++++---
 src/auth/session.ts | 12 ++--
 2 files changed, 38 insertions(+), 19 deletions(-)

### test-runner (exit 0) ✅
All 147 tests passed.

### type-check (exit 0) ✅
No type errors.

### git-diff-full (truncated to 8000 chars)
```diff
diff --git a/src/auth/login.ts b/src/auth/login.ts
...
```​
```

The critic sees this section and can evaluate the builder's work against the actual diff, test results, and type-check output — not just the builder's description of its work.

### Gate Mechanics

When a gate source fails (non-zero exit or pattern match), the harness does **not** forward the event to the next role. Instead:

1. Append `evidence.gate_failed` journal event with the failing source and output
2. Re-prompt the current role with the failure context:

```markdown
## Evidence Gate Failure

The harness ran automated checks after your work and found failures:

### test-runner (exit 1) ❌
```
FAIL src/auth/__tests__/login.test.ts
  ● Login flow › should validate email format
    Expected: "invalid@"
    Received: undefined
```​

Fix these failures before emitting your event. Your previous event emission has been rejected.
```

3. Decrement the remaining iteration budget by 1 (the failed iteration counts)
4. The role gets another turn to fix and re-emit

This is analogous to the existing backpressure system for invalid events, but triggered by real-world verification rather than event schema validation.

### Journal Events

```jsonl
{"run":"abc","iter":"4","topic":"evidence.captured","sources":["git-diff","test-runner","type-check"],"gates_passed":true}
{"run":"abc","iter":"4","topic":"evidence.gate_failed","source":"test-runner","exit_code":1,"output":"FAIL ..."}
{"run":"abc","iter":"4","topic":"evidence.gate_retry","reason":"test-runner failed","remaining_budget":6}
```

### Interaction with Existing Systems

| System | Interaction |
|--------|-------------|
| **Event routing** | Evidence capture runs *before* event routing. Gate failure prevents routing. |
| **Backpressure** | Gate failure is a new backpressure source, parallel to invalid-event backpressure. |
| **Metareview** | Metareview can read evidence from the journal. The adversarial verdict (RFC-001) gets real data. |
| **Memory** | Repeated gate failures on the same source can be auto-promoted to run memory as a learning. |
| **Parallel waves** | Each branch captures evidence independently. Branch evidence is included in wave join summary. |
| **Worktrees** | Evidence commands run in `workDir` (the worktree), not `projectDir`. |
| **Scratchpad** | Evidence is separate from the scratchpad. The scratchpad remains agent-written context. |

### Diff Budget and Truncation

Large diffs can blow the prompt budget. Each evidence source has a `budget_chars` limit. Truncation strategy:

1. If output ≤ budget: inject full output
2. If output > budget: inject `--stat` summary + first N chars of full diff + `... (truncated, full diff: .autoloop/evidence/iter-4/git-diff-full.txt)`
3. Full output always written to disk regardless of truncation

Evidence files stored at: `<stateDir>/evidence/iter-<N>/<source-id>.txt`

### Default Evidence Profile

Presets that modify code (`autocode`, `autofix`, `autotest`, `autosimplify`, `autoperf`, `autosec`) should ship with a default evidence config. The `harness.md` for each preset can include:

```toml
[evidence]
enabled = true

[[evidence.source]]
id = "git-diff"
command = "git diff --stat HEAD"
timeout_ms = 5000

[[evidence.source]]
id = "git-diff-full"
command = "git diff HEAD"
timeout_ms = 10000
budget_chars = 6000
```

Test runner and type-check are **not** defaulted because the commands are project-specific. Users configure them per-project in `autoloops.toml`.

Non-code presets (`autoideas`, `autoresearch`, `autodoc`, `autoreview`, `autospec`) default to `evidence.enabled = false`.

### Preset-Level Evidence Overrides

Evidence config follows the standard layering: preset defaults → project `autoloops.toml` → CLI flags.

```toml
# Project autoloops.toml — adds project-specific test runner
[[evidence.source]]
id = "test-runner"
command = "npm test -- --watchAll=false 2>&1"
timeout_ms = 120000
roles = ["builder"]
gate = true
```

### Protected Paths (Extension: Slice Contract Embryo)

A lightweight precursor to full structured slice contracts. An optional `evidence.protected_paths` config that flags when the diff touches files outside an allowed set:

```toml
[evidence]
protected_paths = ["src/extensions/**", "package.json"]
protected_paths_action = "warn"  # "warn" | "gate"
```

If the diff touches a protected path:
- `"warn"`: inject a warning into the critic's prompt: `"⚠️ This iteration modified protected path: src/extensions/rhai.ts — verify this change was intentional."`
- `"gate"`: block the transition entirely, re-prompt the builder: `"You modified a protected path. Revert changes to src/extensions/rhai.ts or explain why this modification is necessary for the current slice."`

This directly prevents the `ap` design violation (issue #8) — `src/extensions/**` would have been a protected path, and the builder's deletion would have been gated.

## Implementation Plan

### Phase 1: Core Evidence Capture (MVP)

**New files:**

| File | Purpose |
|------|---------|
| `packages/harness/src/evidence.ts` | Evidence source config, capture runner, result types |
| `packages/harness/src/evidence-prompt.ts` | Render evidence into prompt sections |
| `packages/harness/test/harness/evidence.test.ts` | Unit tests for capture + rendering |
| `packages/harness/test/harness/evidence-gate.test.ts` | Gate failure + retry tests |

**Modified files:**

| File | Change |
|------|--------|
| `packages/harness/src/iteration.ts` | Insert `captureEvidence()` call in `finishIteration()` |
| `packages/harness/src/prompt.ts` | Inject evidence section in `renderIterationPromptText()` |
| `packages/harness/src/emit.ts` | Add `evidence.captured`, `evidence.gate_failed`, `evidence.gate_retry` topics |
| `packages/harness/src/types.ts` | Add `evidence` field to `LoopContext` |
| `packages/core/src/config.ts` | Parse `[evidence]` config section |
| `packages/core/src/config-schema.ts` | Schema for evidence config |

**Deliverable:** `git diff --stat` captured after every iteration, full diff injected into critic prompts. No gates yet.

### Phase 2: Gates

Add gate evaluation logic. When a gate source fails, the iteration is retried with the failure context injected. Requires changes to `finishIteration()` control flow and a new `handleGateFailure()` path.

**Deliverable:** Test runner and type-check as gate sources. Builder iterations automatically retried when tests fail.

### Phase 3: Protected Paths

Add diff analysis to detect changes to protected paths. Integrates with the gate system (warn or block).

**Deliverable:** Users can protect files/directories from unintended modification.

### Phase 4: Evidence-Aware Metareview

The metareviewer (RFC-001) gets access to accumulated evidence from all iterations. It can base its CONTINUE/REDIRECT/TAKEOVER/EXIT verdict on actual test results and diff sizes, not just scratchpad summaries.

**Deliverable:** Adversarial metareview with ground-truth data.

## Risks

| Risk | Mitigation |
|------|------------|
| Evidence capture adds latency per iteration | Sources run in parallel where possible; timeout limits prevent stalls. `git diff` is <1s. Test suites are the bottleneck but would be run by the agent anyway. |
| Large diffs blow prompt budget | Per-source `budget_chars` + truncation + full output on disk |
| Gate failures create retry loops | Gate retries count against iteration budget. Max 2 consecutive gate retries before escalating to `evidence.gate_exhausted` stop. |
| Test commands are project-specific, hard to default | Only `git diff` is defaulted. Test/typecheck require explicit config. Clear error message when gate source command not found. |
| Evidence commands modify state (side effects) | Document that evidence commands must be read-only. Consider running in a subshell with read-only filesystem view (future). |
| Prompt injection order conflicts with existing sections | Evidence section inserted after role prompt, before scratchpad — the critic sees evidence before the builder's narrative. |

## Success Metrics

- **Gate catch rate**: % of iterations where gates catch real failures before the critic sees them
- **Critic accuracy**: Compare critic `review.rejected` accuracy with and without evidence injection
- **Design violation prevention**: Protected paths gate should prevent 100% of out-of-scope file modifications
- **Iteration efficiency**: Fewer wasted iterations on broken code reaching the critic
- **Retry cost**: Gate retries should be cheaper than full critic→builder rejection cycles

## Relationship to Other RFCs

| RFC | Relationship |
|-----|-------------|
| **001-adversarial-metareview** | Evidence feeds the metareviewer's verdicts with ground truth. Phase 4 of this RFC. |
| **autoloops-resume** | Evidence is journal-persisted, so resumed runs retain full evidence history. |
| **two-tier-memory** | Repeated gate failures can be auto-promoted to run memory as learnings. |
| **structured-parallelism** | Each parallel branch captures evidence independently; branch evidence included in wave join. |

## Open Questions

1. Should evidence capture be async (non-blocking, results available next iteration) for long-running test suites? This would let the critic start reviewing while tests run, with a late-arriving gate veto if tests fail.
2. Should the harness auto-detect common test runners (npm test, pytest, cargo test, go test) and suggest evidence config during `autoloop init`?
3. Should there be a `--dry-run` mode for evidence config that shows what would be captured without running the loop?
4. How should evidence interact with the `miniloops.toml` lightweight config format — should mini-loops support evidence, or is it an advanced feature only?
5. Should gate failure trigger an automatic `git stash` to clean the working tree before retry, or leave the agent to decide how to fix?
