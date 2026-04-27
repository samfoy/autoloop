/**
 * Resume a previously-terminated run from where it left off.
 *
 * Reuses the original run_id, journal, memory, working files, and worktree.
 * Since the harness re-derives all routing and scratchpad state from the
 * journal each iteration, resume is primarily a lifecycle concern.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as config from "@mobrienv/autoloop-core/config";
import {
  appendEvent,
  extractIteration,
  extractTopic,
  readRunLines,
} from "@mobrienv/autoloop-core/journal";
import { findRunByPrefix, getRun } from "@mobrienv/autoloop-core/registry/read";
import type { RunRecord } from "@mobrienv/autoloop-core/registry/types";
import { appendRegistryEntry } from "@mobrienv/autoloop-core/registry/update";
import {
  updateStatus as updateWorktreeStatus,
} from "@mobrienv/autoloop-core/worktree";
import {
  ensureLayout,
  installRuntimeTools,
  reloadLoop,
} from "./config-helpers.js";
import { log } from "./display.js";
import { runIteration } from "./iteration.js";
import { maybeRunMetareview } from "./metareview.js";
import { registryStop } from "./registry-bridge.js";
import { completeLoop, stopMaxIterations } from "./stop.js";
import type { LoopContext, RunOptions, RunSummary } from "./types.js";

// ── Public API ──────────────────────────────────────────────────────────────

export interface ResumeOptions {
  addIterations?: number;
  backendOverride?: Record<string, unknown>;
  logLevel?: string | null;
  signal?: AbortSignal;
  onEvent?: RunOptions["onEvent"];
}

export interface ResumeValidation {
  ok: boolean;
  error?: string;
  record?: RunRecord;
  resumeIteration?: number;
}

/**
 * Validate whether a run can be resumed. Returns validation result
 * with the record and computed resume iteration on success.
 */
export function validateResume(
  registryFile: string,
  runIdOrPrefix: string,
): ResumeValidation {
  const found = findRunByPrefix(registryFile, runIdOrPrefix);

  if (!found) {
    return { ok: false, error: `No run found matching "${runIdOrPrefix}"` };
  }

  if (Array.isArray(found)) {
    const ids = found.map((r) => r.run_id).join(", ");
    return {
      ok: false,
      error: `Ambiguous run ID "${runIdOrPrefix}" — matches: ${ids}`,
    };
  }

  const record = found;

  if (record.status === "completed") {
    return {
      ok: false,
      error: `Run ${record.run_id} already completed; cannot resume`,
    };
  }

  if (record.status === "running") {
    // Check if PID is still alive
    if (record.pid && isProcessAlive(record.pid)) {
      return {
        ok: false,
        error: `Run ${record.run_id} is still running (PID ${record.pid})`,
      };
    }
    // PID dead — treat as crashed, safe to resume
  }

  // Check journal exists
  if (!existsSync(record.journal_file)) {
    return {
      ok: false,
      error: `Journal not found for run ${record.run_id}: ${record.journal_file}`,
    };
  }

  // Check state dir exists
  if (!existsSync(record.state_dir)) {
    return {
      ok: false,
      error: `State directory for run ${record.run_id} not found: ${record.state_dir}`,
    };
  }

  // Check worktree exists if applicable
  if (
    record.isolation_mode === "worktree" &&
    record.worktree_path &&
    !existsSync(record.worktree_path)
  ) {
    return {
      ok: false,
      error: `Worktree for run ${record.run_id} was cleaned up: ${record.worktree_path}`,
    };
  }

  const resumeIteration = determineResumeIteration(
    record.journal_file,
    record.run_id,
    record.stop_reason,
    record.iteration,
  );

  return { ok: true, record, resumeIteration };
}

/**
 * Resume a run from where it left off.
 */
export async function resume(
  runIdOrPrefix: string,
  selfCommand: string,
  options: ResumeOptions = {},
): Promise<RunSummary> {
  // Find the registry file — scan common locations
  const registryFile = resolveRegistryFile();
  const validation = validateResume(registryFile, runIdOrPrefix);

  if (!validation.ok || !validation.record || !validation.resumeIteration) {
    console.error(validation.error);
    return { iterations: 0, stopReason: "resume_failed" };
  }

  const record = validation.record;
  const resumeIter = validation.resumeIteration;

  // Compute new iteration budget
  const addIterations =
    options.addIterations ?? record.max_iterations;
  const newMaxIterations = (resumeIter - 1) + addIterations;

  if (addIterations <= 0) {
    console.error("No iterations to run (--add-iterations must be > 0)");
    return { iterations: 0, stopReason: "resume_failed" };
  }

  // Build LoopContext from the existing record
  const loop = buildResumeContext(
    record,
    newMaxIterations,
    selfCommand,
    options,
  );

  // Auto-stash any dirty working tree from the crashed run
  autoStashDirtyTree(loop.paths.workDir, record.run_id);

  // Journal the resume event
  appendEvent(
    loop.paths.journalFile,
    loop.runtime.runId,
    "",
    "loop.resume",
    JSON.stringify({
      resumed_from_iteration: resumeIter,
      previous_stop_reason: record.stop_reason,
      add_iterations: addIterations,
      new_max_iterations: newMaxIterations,
    }),
  );

  // Update registry: status → running, new PID
  const updatedRecord: RunRecord = {
    ...record,
    status: "running",
    pid: process.pid,
    max_iterations: newMaxIterations,
    updated_at: new Date().toISOString(),
  };
  appendRegistryEntry(registryFile, updatedRecord);

  // Update worktree meta if applicable
  if (
    record.isolation_mode === "worktree" &&
    record.worktree_path
  ) {
    const metaDir = join(
      record.state_dir.replace(/\/.autoloop$/, "/.autoloop"),
      "worktrees",
      record.worktree_name || record.run_id,
    );
    try {
      if (existsSync(metaDir)) {
        updateWorktreeStatus(metaDir, "running");
      }
    } catch {
      /* best-effort */
    }
  }

  log(
    loop,
    "info",
    `loop resume run_id=${loop.runtime.runId} from_iteration=${resumeIter} max_iterations=${newMaxIterations}`,
  );

  console.log(
    `Resuming run ${record.run_id} from iteration ${resumeIter} (budget: ${addIterations} iterations, max: ${newMaxIterations})`,
  );
  if (record.stop_reason) {
    console.log(`Previous stop reason: ${record.stop_reason}`);
  }

  // Set up abort handling
  let aborted = false;
  let currentIteration = resumeIter;

  const teardown = () => {
    if (aborted) return;
    aborted = true;
    try {
      registryStop(loop, currentIteration, "interrupted");
    } catch {
      /* best-effort */
    }
  };

  const onAbort = () => teardown();
  options.signal?.addEventListener("abort", onAbort);
  if (options.signal?.aborted) teardown();

  // Enter iteration loop at resume point
  const trackedIterate = (ctx: LoopContext, iter: number): RunSummary => {
    if (aborted) {
      return {
        iterations: iter - 1,
        stopReason: "interrupted",
        runId: ctx.runtime.runId,
      };
    }
    currentIteration = iter;
    ctx.onEvent?.({
      type: "iteration.start",
      iteration: iter,
      maxIterations: ctx.limits.maxIterations,
      runId: ctx.runtime.runId,
    });
    return iterateWith(ctx, iter, trackedIterate);
  };

  let summary: RunSummary;
  try {
    summary = trackedIterate(loop, resumeIter);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  loop.onEvent?.({
    type: "summary",
    runId: loop.runtime.runId,
    iterations: summary.iterations,
    stopReason: summary.stopReason,
    journalFile: loop.paths.journalFile,
    memoryFile: loop.paths.memoryFile,
    reviewEvery: loop.review.every,
    toolPath: loop.paths.toolPath,
  });
  loop.onEvent?.({
    type: "loop.finish",
    iterations: summary.iterations,
    stopReason: summary.stopReason,
    runId: loop.runtime.runId,
  });

  return { ...summary, runId: loop.runtime.runId };
}

// ── Internal ────────────────────────────────────────────────────────────────

/**
 * Determine which iteration to resume from based on stop reason and journal state.
 */
export function determineResumeIteration(
  journalFile: string,
  runId: string,
  stopReason: string,
  registryIteration: number,
): number {
  if (stopReason === "max_iterations") {
    // The run was blocked before this iteration could run
    return registryIteration + 1;
  }

  if (stopReason === "backend_failed" || stopReason === "backend_timeout") {
    // The iteration started but backend failed — retry it
    return registryIteration;
  }

  // For "interrupted" and other reasons, check the journal
  const runLines = readRunLines(journalFile, runId);
  const iterStr = String(registryIteration);
  const hasFinish = runLines.some(
    (line) =>
      extractTopic(line) === "iteration.finish" &&
      extractIteration(line) === iterStr,
  );

  if (hasFinish) {
    // Iteration completed, start next one
    return registryIteration + 1;
  }

  // Iteration started but didn't finish — retry it
  return registryIteration;
}

/**
 * Build a LoopContext for a resumed run from the existing RunRecord.
 */
function buildResumeContext(
  record: RunRecord,
  newMaxIterations: number,
  selfCommand: string,
  options: ResumeOptions,
): LoopContext {
  const cfg = config.loadProject(record.project_dir);
  const backendOverride = options.backendOverride ?? {};
  const logLevel =
    options.logLevel ?? config.get(cfg, "core.log_level", "info");

  // Resolve memory file paths
  const memoryFile = config.resolveMemoryFileIn(
    record.project_dir,
    record.work_dir,
  );
  const runMemoryFile = join(record.state_dir, "memory.jsonl");

  // Seed a LoopContext with the record's paths, then let reloadLoop fill the rest
  const seed = {
    paths: {
      projectDir: record.project_dir,
      workDir: record.work_dir,
      stateDir: record.state_dir,
      journalFile: record.journal_file,
      memoryFile,
      runMemoryFile,
      tasksFile: join(record.state_dir, "tasks.jsonl"),
      registryFile: resolveRegistryFile(),
      toolPath: join(record.state_dir, "autoloops"),
      piAdapterPath: join(record.state_dir, "pi-adapter"),
      baseStateDir: record.state_dir.replace(/\/runs\/[^/]+$/, ""),
      mainProjectDir: record.project_dir,
      worktreeBranch: record.worktree_name || "",
      worktreePath: record.worktree_path || "",
      worktreeMetaDir: "",
    },
    runtime: {
      runId: record.run_id, // Reuse the original run ID
      selfCommand,
      promptOverride: null,
      backendOverride,
      logLevel,
      branchMode: false,
      isolationMode: record.isolation_mode || "run-scoped",
    },
    launch: {
      preset: record.preset,
      trigger: record.trigger as "cli" | "chain" | "branch",
      createdAt: record.created_at,
      parentRunId: record.parent_run_id,
    },
    profiles: {
      active: [] as string[],
      fragments: new Map<string, string>(),
      warnings: [] as string[],
    },
    store: {},
  } as unknown as LoopContext;

  // reloadLoop fills topology, backend, review, etc. from current config
  const loaded = reloadLoop(seed);

  // Override max iterations with the resume budget
  loaded.limits.maxIterations = newMaxIterations;

  // Wire up event emitter
  loaded.onEvent = options.onEvent;

  // Ensure runtime tools are installed
  ensureLayout(loaded.paths.stateDir);
  installRuntimeTools(loaded);

  return loaded;
}

/**
 * Auto-stash dirty working tree from a crashed run.
 * This prevents partial edits with unused variables from breaking the build.
 */
function autoStashDirtyTree(workDir: string, runId: string): void {
  try {
    const { execSync } = require("node:child_process");
    const status = execSync("git status --porcelain", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (status) {
      console.log(
        `Auto-stashing dirty working tree from previous run (${status.split("\n").length} files)`,
      );
      execSync(
        `git stash push -m "autoloop-resume: auto-stash from crashed run ${runId}"`,
        { cwd: workDir, timeout: 10000 },
      );
    }
  } catch {
    // Not a git repo, or stash failed — continue anyway
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRegistryFile(): string {
  // Check standard locations
  const cwd = process.cwd();
  const candidates = [
    join(cwd, ".autoloop", "registry.jsonl"),
    join(cwd, "registry.jsonl"),
  ];

  // Also check AUTOLOOP_STATE_DIR env
  const stateDir = process.env.AUTOLOOP_STATE_DIR;
  if (stateDir) {
    candidates.unshift(join(stateDir, "registry.jsonl"));
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  // Default
  return join(cwd, ".autoloop", "registry.jsonl");
}

/**
 * Iterate with hot-reload, metareview, and limits — same as the main loop
 * but extracted here so resume can use it without importing the full index.
 */
function iterateWith(
  loop: LoopContext,
  iteration: number,
  recurse: (loop: LoopContext, iteration: number) => RunSummary,
): RunSummary {
  const liveLoop = reloadLoop(loop);
  liveLoop.kiroSession = loop.kiroSession;
  installRuntimeTools(liveLoop);
  const reviewed = maybeRunMetareview(liveLoop, iteration);

  if (iteration > reviewed.limits.maxIterations) {
    return stopMaxIterations(reviewed, iteration);
  }
  return runIteration(reviewed, iteration, recurse);
}
