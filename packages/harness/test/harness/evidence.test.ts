import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach } from "vitest";
import {
  captureEvidence,
  defaultEvidenceConfig,
  defaultSource,
  evidenceToJournalPayload,
  parseEvidenceConfig,
  renderEvidencePrompt,
  renderGateFailurePrompt,
  runEvidenceSource,
} from "../../src/evidence.js";
import type { EvidenceConfig, EvidenceSource, IterationEvidence } from "../../src/evidence.js";

function tmpDir(): string {
  const dir = join(tmpdir(), `evidence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("parseEvidenceConfig", () => {
  it("returns disabled config when no evidence section", () => {
    const cfg = parseEvidenceConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.sources).toEqual([]);
  });

  it("returns disabled when enabled=false", () => {
    const cfg = parseEvidenceConfig({
      evidence: { enabled: false, source: [{ id: "test", command: "echo hi" }] },
    });
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when no sources configured", () => {
    const cfg = parseEvidenceConfig({
      evidence: { enabled: true },
    });
    expect(cfg.enabled).toBe(false);
  });

  it("parses a complete evidence config", () => {
    const cfg = parseEvidenceConfig({
      evidence: {
        enabled: true,
        max_gate_retries: 3,
        protected_paths: ["src/extensions/**"],
        protected_paths_action: "gate",
        source: [
          {
            id: "git-diff",
            command: "git diff --stat HEAD",
            timeout_ms: 5000,
          },
          {
            id: "test-runner",
            command: "npm test",
            timeout_ms: 120000,
            roles: ["builder"],
            gate: true,
            gate_on: "exit_code",
          },
        ],
      },
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.max_gate_retries).toBe(3);
    expect(cfg.protected_paths).toEqual(["src/extensions/**"]);
    expect(cfg.protected_paths_action).toBe("gate");
    expect(cfg.sources).toHaveLength(2);

    expect(cfg.sources[0].id).toBe("git-diff");
    expect(cfg.sources[0].gate).toBe(false);
    expect(cfg.sources[0].roles).toEqual([]);

    expect(cfg.sources[1].id).toBe("test-runner");
    expect(cfg.sources[1].gate).toBe(true);
    expect(cfg.sources[1].roles).toEqual(["builder"]);
  });
});

describe("runEvidenceSource", () => {
  it("captures successful command output", () => {
    const source = defaultSource({
      id: "echo-test",
      command: 'echo "hello world"',
      timeout_ms: 5000,
    });
    const result = runEvidenceSource(source, process.cwd());
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.gate_passed).toBeNull(); // not a gate source
  });

  it("captures failed command with exit code", () => {
    const source = defaultSource({
      id: "fail-test",
      command: "exit 1",
      timeout_ms: 5000,
      gate: true,
    });
    const result = runEvidenceSource(source, process.cwd());
    expect(result.exit_code).toBe(1);
    expect(result.gate_passed).toBe(false);
  });

  it("gate passes on zero exit code", () => {
    const source = defaultSource({
      id: "pass-test",
      command: "echo ok",
      timeout_ms: 5000,
      gate: true,
    });
    const result = runEvidenceSource(source, process.cwd());
    expect(result.exit_code).toBe(0);
    expect(result.gate_passed).toBe(true);
  });

  it("gate fails on pattern match", () => {
    const source = defaultSource({
      id: "pattern-test",
      command: 'echo "FAIL: something broke"',
      timeout_ms: 5000,
      gate: true,
      gate_on: "pattern",
      gate_pattern: "FAIL:",
    });
    const result = runEvidenceSource(source, process.cwd());
    expect(result.exit_code).toBe(0); // command succeeded
    expect(result.gate_passed).toBe(false); // but pattern matched
  });

  it("gate passes when pattern does not match", () => {
    const source = defaultSource({
      id: "pattern-pass",
      command: 'echo "all tests passed"',
      timeout_ms: 5000,
      gate: true,
      gate_on: "pattern",
      gate_pattern: "FAIL:",
    });
    const result = runEvidenceSource(source, process.cwd());
    expect(result.gate_passed).toBe(true);
  });
});

describe("captureEvidence", () => {
  it("runs only applicable sources for the given role", () => {
    const workDir = tmpDir();
    const stateDir = tmpDir();
    const config: EvidenceConfig = {
      ...defaultEvidenceConfig(),
      enabled: true,
      sources: [
        defaultSource({
          id: "all-roles",
          command: 'echo "for everyone"',
          roles: [],
        }),
        defaultSource({
          id: "builder-only",
          command: 'echo "builder stuff"',
          roles: ["builder"],
        }),
        defaultSource({
          id: "critic-only",
          command: 'echo "critic stuff"',
          roles: ["critic"],
        }),
      ],
    };

    const evidence = captureEvidence(config, workDir, stateDir, 3, "builder");
    expect(evidence.results).toHaveLength(2);
    expect(evidence.results.map((r) => r.source_id)).toEqual([
      "all-roles",
      "builder-only",
    ]);
    expect(evidence.role).toBe("builder");
    expect(evidence.iteration).toBe(3);
  });

  it("writes evidence files to disk", () => {
    const workDir = tmpDir();
    const stateDir = tmpDir();
    const config: EvidenceConfig = {
      ...defaultEvidenceConfig(),
      enabled: true,
      sources: [
        defaultSource({ id: "disk-test", command: 'echo "persisted"' }),
      ],
    };

    captureEvidence(config, workDir, stateDir, 1, "builder");
    const path = join(stateDir, "evidence", "iter-1", "disk-test.txt");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("persisted");
  });

  it("overall_gate_passed is false when any gate fails", () => {
    const workDir = tmpDir();
    const stateDir = tmpDir();
    const config: EvidenceConfig = {
      ...defaultEvidenceConfig(),
      enabled: true,
      sources: [
        defaultSource({ id: "pass", command: "echo ok", gate: true }),
        defaultSource({ id: "fail", command: "exit 1", gate: true }),
      ],
    };

    const evidence = captureEvidence(config, workDir, stateDir, 1, "builder");
    expect(evidence.overall_gate_passed).toBe(false);
  });

  it("overall_gate_passed is true when all gates pass", () => {
    const workDir = tmpDir();
    const stateDir = tmpDir();
    const config: EvidenceConfig = {
      ...defaultEvidenceConfig(),
      enabled: true,
      sources: [
        defaultSource({ id: "a", command: "echo ok", gate: true }),
        defaultSource({ id: "b", command: "echo ok", gate: true }),
      ],
    };

    const evidence = captureEvidence(config, workDir, stateDir, 1, "builder");
    expect(evidence.overall_gate_passed).toBe(true);
  });
});

describe("renderEvidencePrompt", () => {
  it("renders a readable markdown section", () => {
    const evidence: IterationEvidence = {
      iteration: 4,
      role: "builder",
      captured_at: "2026-04-27T00:00:00Z",
      results: [
        {
          source_id: "git-diff",
          exit_code: 0,
          stdout: " src/auth.ts | 10 +++++\n 1 file changed",
          stderr: "",
          truncated: false,
          elapsed_ms: 50,
          gate_passed: null,
        },
        {
          source_id: "test-runner",
          exit_code: 0,
          stdout: "All 42 tests passed",
          stderr: "",
          truncated: false,
          elapsed_ms: 3000,
          gate_passed: true,
        },
      ],
      overall_gate_passed: true,
    };

    const rendered = renderEvidencePrompt(evidence);
    expect(rendered).toContain("## Harness Evidence (iteration 4, role: builder)");
    expect(rendered).toContain("captured by the harness");
    expect(rendered).toContain("### git-diff ℹ️");
    expect(rendered).toContain("### test-runner ✅");
    expect(rendered).toContain("All 42 tests passed");
  });

  it("renders gate failures with ❌", () => {
    const evidence: IterationEvidence = {
      iteration: 5,
      role: "builder",
      captured_at: "2026-04-27T00:00:00Z",
      results: [
        {
          source_id: "type-check",
          exit_code: 1,
          stdout: "error TS2345: Argument of type...",
          stderr: "",
          truncated: false,
          elapsed_ms: 2000,
          gate_passed: false,
        },
      ],
      overall_gate_passed: false,
    };

    const rendered = renderEvidencePrompt(evidence);
    expect(rendered).toContain("### type-check (exit 1) ❌");
  });

  it("returns empty string when no results", () => {
    const evidence: IterationEvidence = {
      iteration: 1,
      role: "builder",
      captured_at: "2026-04-27T00:00:00Z",
      results: [],
      overall_gate_passed: true,
    };
    expect(renderEvidencePrompt(evidence)).toBe("");
  });
});

describe("renderGateFailurePrompt", () => {
  it("renders failure context for the agent", () => {
    const evidence: IterationEvidence = {
      iteration: 3,
      role: "builder",
      captured_at: "2026-04-27T00:00:00Z",
      results: [
        {
          source_id: "test-runner",
          exit_code: 1,
          stdout: "FAIL src/auth.test.ts\n  Expected: true\n  Received: false",
          stderr: "",
          truncated: false,
          elapsed_ms: 5000,
          gate_passed: false,
        },
        {
          source_id: "type-check",
          exit_code: 0,
          stdout: "No errors",
          stderr: "",
          truncated: false,
          elapsed_ms: 1000,
          gate_passed: true,
        },
      ],
      overall_gate_passed: false,
    };

    const rendered = renderGateFailurePrompt(evidence);
    expect(rendered).toContain("## Evidence Gate Failure");
    expect(rendered).toContain("test-runner (exit 1) ❌");
    expect(rendered).toContain("FAIL src/auth.test.ts");
    // Should NOT include the passing source
    expect(rendered).not.toContain("type-check");
  });
});

describe("evidenceToJournalPayload", () => {
  it("produces compact JSON for journal storage", () => {
    const evidence: IterationEvidence = {
      iteration: 2,
      role: "builder",
      captured_at: "2026-04-27T00:00:00Z",
      results: [
        {
          source_id: "git-diff",
          exit_code: 0,
          stdout: "lots of diff output...",
          stderr: "",
          truncated: false,
          elapsed_ms: 100,
          gate_passed: null,
        },
      ],
      overall_gate_passed: true,
    };

    const payload = evidenceToJournalPayload(evidence);
    const parsed = JSON.parse(payload);
    expect(parsed.role).toBe("builder");
    expect(parsed.gate_passed).toBe(true);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0].id).toBe("git-diff");
    expect(parsed.sources[0].exit).toBe(0);
    // Full stdout should NOT be in the journal payload (it's on disk)
    expect(payload).not.toContain("lots of diff output");
  });
});
