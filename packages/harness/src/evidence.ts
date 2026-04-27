/**
 * Harness-captured evidence: runs configured commands between iterations
 * to capture ground truth (diffs, test results, diagnostics) independently
 * of agent self-reports.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface EvidenceSource {
  /** Unique identifier, e.g. "git-diff", "test-runner" */
  id: string;
  /** Shell command to run (executed in workDir) */
  command: string;
  /** Max execution time in ms */
  timeout_ms: number;
  /** Only run after these roles (empty = all roles) */
  roles: string[];
  /** If true, non-zero exit blocks transition to next role */
  gate: boolean;
  /** What constitutes a gate failure */
  gate_on: "exit_code" | "pattern";
  /** Regex pattern — if matched in output, gate fails (only when gate_on=pattern) */
  gate_pattern: string;
  /** Max chars to inject into the next iteration's prompt */
  budget_chars: number;
}

export interface EvidenceResult {
  source_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  elapsed_ms: number;
  gate_passed: boolean | null;
}

export interface IterationEvidence {
  iteration: number;
  role: string;
  captured_at: string;
  results: EvidenceResult[];
  overall_gate_passed: boolean;
}

export interface EvidenceConfig {
  enabled: boolean;
  sources: EvidenceSource[];
  /** Max consecutive gate retries before escalating to a stop */
  max_gate_retries: number;
  /** Optional list of protected path globs */
  protected_paths: string[];
  /** Action when protected paths are touched: "warn" or "gate" */
  protected_paths_action: "warn" | "gate";
}

// ── Defaults ────────────────────────────────────────────────────────────────

export function defaultEvidenceConfig(): EvidenceConfig {
  return {
    enabled: false,
    sources: [],
    max_gate_retries: 2,
    protected_paths: [],
    protected_paths_action: "warn",
  };
}

export function defaultSource(partial: Partial<EvidenceSource>): EvidenceSource {
  return {
    id: partial.id ?? "unnamed",
    command: partial.command ?? "echo no-op",
    timeout_ms: partial.timeout_ms ?? 30000,
    roles: partial.roles ?? [],
    gate: partial.gate ?? false,
    gate_on: partial.gate_on ?? "exit_code",
    gate_pattern: partial.gate_pattern ?? "",
    budget_chars: partial.budget_chars ?? 4000,
  };
}

// ── Config Parsing ──────────────────────────────────────────────────────────

/**
 * Parse evidence config from a raw TOML-parsed config object.
 * Expects the `evidence` key at the top level.
 */
export function parseEvidenceConfig(
  raw: Record<string, unknown>,
): EvidenceConfig {
  const section = raw.evidence as Record<string, unknown> | undefined;
  if (!section) return defaultEvidenceConfig();

  const enabled = section.enabled !== false && section.enabled !== "false";
  const maxRetries =
    typeof section.max_gate_retries === "number"
      ? section.max_gate_retries
      : typeof section.max_gate_retries === "string"
        ? parseInt(section.max_gate_retries, 10) || 2
        : 2;

  const protectedPaths = parseStringArray(section.protected_paths);
  const protectedAction =
    section.protected_paths_action === "gate" ? "gate" : "warn";

  // Parse source array — TOML [[evidence.source]] becomes an array
  const rawSources = section.source;
  const sources: EvidenceSource[] = [];
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === "object" && s !== null) {
        const src = s as Record<string, unknown>;
        sources.push(
          defaultSource({
            id: typeof src.id === "string" ? src.id : undefined,
            command: typeof src.command === "string" ? src.command : undefined,
            timeout_ms:
              typeof src.timeout_ms === "number"
                ? src.timeout_ms
                : typeof src.timeout_ms === "string"
                  ? parseInt(src.timeout_ms, 10) || undefined
                  : undefined,
            roles: parseStringArray(src.roles),
            gate:
              src.gate === true || src.gate === "true" ? true : false,
            gate_on:
              src.gate_on === "pattern" ? "pattern" : "exit_code",
            gate_pattern:
              typeof src.gate_pattern === "string" ? src.gate_pattern : "",
            budget_chars:
              typeof src.budget_chars === "number"
                ? src.budget_chars
                : typeof src.budget_chars === "string"
                  ? parseInt(src.budget_chars, 10) || undefined
                  : undefined,
          }),
        );
      }
    }
  }

  return {
    enabled: enabled && sources.length > 0,
    sources,
    max_gate_retries: maxRetries,
    protected_paths: protectedPaths,
    protected_paths_action: protectedAction,
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * Run all applicable evidence sources for the given role and iteration.
 * Returns structured results with gate evaluation.
 */
export function captureEvidence(
  config: EvidenceConfig,
  workDir: string,
  stateDir: string,
  iteration: number,
  role: string,
): IterationEvidence {
  const applicable = config.sources.filter(
    (s) => s.roles.length === 0 || s.roles.includes(role),
  );

  const evidenceDir = join(stateDir, "evidence", `iter-${iteration}`);
  mkdirSync(evidenceDir, { recursive: true });

  const results: EvidenceResult[] = [];
  for (const source of applicable) {
    const result = runEvidenceSource(source, workDir);
    // Persist full output to disk regardless of budget
    writeFileSync(
      join(evidenceDir, `${source.id}.txt`),
      result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""),
    );
    results.push(result);
  }

  const overall = results.every((r) => r.gate_passed !== false);

  return {
    iteration,
    role,
    captured_at: new Date().toISOString(),
    results,
    overall_gate_passed: overall,
  };
}

/**
 * Execute a single evidence source command and evaluate its gate condition.
 */
export function runEvidenceSource(
  source: EvidenceSource,
  workDir: string,
): EvidenceResult {
  const start = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const output = execSync(source.command, {
      cwd: workDir,
      timeout: source.timeout_ms,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    stdout = output ?? "";
  } catch (err: unknown) {
    const execErr = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    exitCode = execErr.status ?? 1;
    stdout = execErr.stdout ?? "";
    stderr = execErr.stderr ?? "";
    if (execErr.killed) {
      stderr += "\n[evidence: command timed out]";
    }
  }

  const elapsed = Date.now() - start;
  const truncated = stdout.length > source.budget_chars;

  let gatePassed: boolean | null = null;
  if (source.gate) {
    if (source.gate_on === "pattern" && source.gate_pattern) {
      try {
        const regex = new RegExp(source.gate_pattern);
        // Pattern match = gate failure
        gatePassed = !regex.test(stdout + stderr);
      } catch {
        // Invalid regex — treat as gate pass to avoid blocking
        gatePassed = true;
      }
    } else {
      // Default: exit_code
      gatePassed = exitCode === 0;
    }
  }

  return {
    source_id: source.id,
    exit_code: exitCode,
    stdout,
    stderr,
    truncated,
    elapsed_ms: elapsed,
    gate_passed: gatePassed,
  };
}

// ── Prompt Rendering ────────────────────────────────────────────────────────

/**
 * Render evidence results into a markdown section for prompt injection.
 */
export function renderEvidencePrompt(evidence: IterationEvidence): string {
  if (evidence.results.length === 0) return "";

  let out = `## Harness Evidence (iteration ${evidence.iteration}, role: ${evidence.role})\n\n`;
  out +=
    "> This evidence was captured by the harness, not reported by any agent role.\n";
  out += "> Treat it as ground truth.\n\n";

  for (const result of evidence.results) {
    const status =
      result.gate_passed === false
        ? "❌"
        : result.gate_passed === true
          ? "✅"
          : "ℹ️";
    const exitLabel =
      result.exit_code === 0 ? "" : ` (exit ${result.exit_code})`;

    out += `### ${result.source_id}${exitLabel} ${status}\n\n`;

    const content = truncateOutput(result.stdout, result.source_id);
    if (content.trim()) {
      out += "```\n" + content + "\n```\n\n";
    } else {
      out += "(no output)\n\n";
    }

    if (result.stderr && result.exit_code !== 0) {
      const stderrContent = truncateOutput(result.stderr, `${result.source_id}-stderr`);
      if (stderrContent.trim()) {
        out += "stderr:\n```\n" + stderrContent + "\n```\n\n";
      }
    }
  }

  return out;
}

/**
 * Render a gate failure message for re-prompting the current role.
 */
export function renderGateFailurePrompt(evidence: IterationEvidence): string {
  const failures = evidence.results.filter((r) => r.gate_passed === false);
  if (failures.length === 0) return "";

  let out = "## Evidence Gate Failure\n\n";
  out +=
    "The harness ran automated checks after your work and found failures.\n";
  out +=
    "Fix these failures before emitting your event. Your previous event emission has been rejected.\n\n";

  for (const f of failures) {
    out += `### ${f.source_id} (exit ${f.exit_code}) ❌\n\n`;
    const content = truncateOutput(
      f.stdout + (f.stderr ? "\n" + f.stderr : ""),
      f.source_id,
    );
    out += "```\n" + content + "\n```\n\n";
  }

  return out;
}

function truncateOutput(text: string, _label: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  return (
    head +
    `\n\n... (${text.length - maxChars} chars truncated) ...\n\n` +
    tail
  );
}

// ── Journal Helpers ─────────────────────────────────────────────────────────

/**
 * Serialize evidence into a compact JSON string for journal storage.
 */
export function evidenceToJournalPayload(evidence: IterationEvidence): string {
  const summaries = evidence.results.map((r) => ({
    id: r.source_id,
    exit: r.exit_code,
    gate: r.gate_passed,
    ms: r.elapsed_ms,
    truncated: r.truncated,
    chars: r.stdout.length,
  }));
  return JSON.stringify({
    role: evidence.role,
    gate_passed: evidence.overall_gate_passed,
    sources: summaries,
  });
}
