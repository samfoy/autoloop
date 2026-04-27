import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  determineResumeIteration,
  validateResume,
} from "../../src/resume.js";
import { encodeEvent } from "@mobrienv/autoloop-core";

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRegistry(dir: string, records: object[]): string {
  const path = join(dir, "registry.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function writeJournal(dir: string, events: Array<{ run: string; iteration?: string; topic: string; fields?: Record<string, string> }>): string {
  const path = join(dir, "journal.jsonl");
  const lines = events.map((e) =>
    encodeEvent({
      shape: "fields",
      run: e.run,
      iteration: e.iteration,
      topic: e.topic,
      fields: e.fields ?? {},
      rawFields: e.fields ?? {},
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("determineResumeIteration", () => {
  it("returns iteration+1 for max_iterations stop", () => {
    const dir = tmpDir();
    const journalFile = writeJournal(dir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
      { run: "run-1", iteration: "1", topic: "iteration.finish", fields: { exit_code: "0", output: "done" } },
      { run: "run-1", iteration: "2", topic: "iteration.start" },
      { run: "run-1", iteration: "2", topic: "iteration.finish", fields: { exit_code: "0", output: "done" } },
      { run: "run-1", iteration: "3", topic: "iteration.start" },
      { run: "run-1", iteration: "3", topic: "iteration.finish", fields: { exit_code: "0", output: "done" } },
    ]);
    expect(determineResumeIteration(journalFile, "run-1", "max_iterations", 3)).toBe(4);
  });

  it("retries the failed iteration for backend_failed", () => {
    const dir = tmpDir();
    const journalFile = writeJournal(dir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
      { run: "run-1", iteration: "1", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
      { run: "run-1", iteration: "2", topic: "iteration.start" },
      // No iteration.finish for iter 2 — it failed
    ]);
    expect(determineResumeIteration(journalFile, "run-1", "backend_failed", 2)).toBe(2);
  });

  it("retries the failed iteration for backend_timeout", () => {
    const dir = tmpDir();
    const journalFile = writeJournal(dir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
      { run: "run-1", iteration: "1", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
      { run: "run-1", iteration: "2", topic: "iteration.start" },
    ]);
    expect(determineResumeIteration(journalFile, "run-1", "backend_timeout", 2)).toBe(2);
  });

  it("returns iteration+1 for interrupted with finished iteration", () => {
    const dir = tmpDir();
    const journalFile = writeJournal(dir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
      { run: "run-1", iteration: "1", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
      { run: "run-1", iteration: "2", topic: "iteration.start" },
      { run: "run-1", iteration: "2", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
    ]);
    expect(determineResumeIteration(journalFile, "run-1", "interrupted", 2)).toBe(3);
  });

  it("retries for interrupted with unfinished iteration", () => {
    const dir = tmpDir();
    const journalFile = writeJournal(dir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
      { run: "run-1", iteration: "1", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
      { run: "run-1", iteration: "2", topic: "iteration.start" },
      // Interrupted mid-iteration — no finish
    ]);
    expect(determineResumeIteration(journalFile, "run-1", "interrupted", 2)).toBe(2);
  });
});

describe("validateResume", () => {
  it("rejects when no run found", () => {
    const dir = tmpDir();
    const reg = writeRegistry(dir, []);
    const result = validateResume(reg, "nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No run found");
  });

  it("rejects completed runs", () => {
    const dir = tmpDir();
    const stateDir = join(dir, ".autoloop");
    mkdirSync(stateDir, { recursive: true });
    const journalFile = writeJournal(stateDir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
    ]);
    const reg = writeRegistry(dir, [
      {
        run_id: "run-1",
        status: "completed",
        stop_reason: "completion_event",
        journal_file: journalFile,
        state_dir: stateDir,
        iteration: 3,
        project_dir: dir,
        work_dir: dir,
        preset: "autocode",
        objective: "test",
        trigger: "cli",
        created_at: "2026-04-27",
        updated_at: "2026-04-27",
      },
    ]);
    const result = validateResume(reg, "run-1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already completed");
  });

  it("rejects runs with live PID", () => {
    const dir = tmpDir();
    const stateDir = join(dir, ".autoloop");
    mkdirSync(stateDir, { recursive: true });
    const journalFile = writeJournal(stateDir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
    ]);
    const reg = writeRegistry(dir, [
      {
        run_id: "run-1",
        status: "running",
        pid: process.pid, // current process is alive
        journal_file: journalFile,
        state_dir: stateDir,
        iteration: 2,
        project_dir: dir,
        work_dir: dir,
        preset: "autocode",
        objective: "test",
        trigger: "cli",
        created_at: "2026-04-27",
        updated_at: "2026-04-27",
      },
    ]);
    const result = validateResume(reg, "run-1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("still running");
  });

  it("accepts failed runs with dead PID", () => {
    const dir = tmpDir();
    const stateDir = join(dir, ".autoloop");
    mkdirSync(stateDir, { recursive: true });
    const journalFile = writeJournal(stateDir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
      { run: "run-1", iteration: "1", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
      { run: "run-1", iteration: "2", topic: "iteration.start" },
    ]);
    const reg = writeRegistry(dir, [
      {
        run_id: "run-1",
        status: "failed",
        stop_reason: "backend_failed",
        pid: 99999999, // almost certainly dead
        journal_file: journalFile,
        state_dir: stateDir,
        iteration: 2,
        max_iterations: 10,
        project_dir: dir,
        work_dir: dir,
        preset: "autocode",
        objective: "test",
        trigger: "cli",
        created_at: "2026-04-27",
        updated_at: "2026-04-27",
      },
    ]);
    const result = validateResume(reg, "run-1");
    expect(result.ok).toBe(true);
    expect(result.resumeIteration).toBe(2); // retry the failed iteration
    expect(result.record?.run_id).toBe("run-1");
  });

  it("accepts stopped runs (max_iterations)", () => {
    const dir = tmpDir();
    const stateDir = join(dir, ".autoloop");
    mkdirSync(stateDir, { recursive: true });
    const journalFile = writeJournal(stateDir, [
      { run: "run-1", iteration: "1", topic: "iteration.start" },
      { run: "run-1", iteration: "1", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
      { run: "run-1", iteration: "2", topic: "iteration.start" },
      { run: "run-1", iteration: "2", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
      { run: "run-1", iteration: "3", topic: "iteration.start" },
      { run: "run-1", iteration: "3", topic: "iteration.finish", fields: { exit_code: "0", output: "ok" } },
    ]);
    const reg = writeRegistry(dir, [
      {
        run_id: "run-1",
        status: "stopped",
        stop_reason: "max_iterations",
        pid: 99999999,
        journal_file: journalFile,
        state_dir: stateDir,
        iteration: 3,
        max_iterations: 3,
        project_dir: dir,
        work_dir: dir,
        preset: "autocode",
        objective: "test",
        trigger: "cli",
        created_at: "2026-04-27",
        updated_at: "2026-04-27",
      },
    ]);
    const result = validateResume(reg, "run-1");
    expect(result.ok).toBe(true);
    expect(result.resumeIteration).toBe(4); // next iteration after the limit
  });

  it("rejects ambiguous prefix matches", () => {
    const dir = tmpDir();
    const reg = writeRegistry(dir, [
      { run_id: "swift-wave", status: "failed", stop_reason: "backend_failed" },
      { run_id: "swift-wind", status: "failed", stop_reason: "backend_failed" },
    ]);
    const result = validateResume(reg, "swift");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Ambiguous");
  });

  it("rejects when journal is missing", () => {
    const dir = tmpDir();
    const stateDir = join(dir, ".autoloop");
    mkdirSync(stateDir, { recursive: true });
    const reg = writeRegistry(dir, [
      {
        run_id: "run-1",
        status: "failed",
        stop_reason: "backend_failed",
        journal_file: join(stateDir, "nonexistent.jsonl"),
        state_dir: stateDir,
        iteration: 1,
        project_dir: dir,
        work_dir: dir,
      },
    ]);
    const result = validateResume(reg, "run-1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Journal not found");
  });
});
