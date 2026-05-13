import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Extract the Python BRIDGE_SCRIPT from the source so the test exercises
// the exact script shipped in the adapter.
function loadBridgeScript(): string {
  const src = readFileSync(join(__dirname, "../../src/pi-adapter.ts"), "utf-8");
  const match = src.match(/const BRIDGE_SCRIPT = `([\s\S]*?)`;/);
  if (!match) {
    throw new Error("could not locate BRIDGE_SCRIPT in pi-adapter.ts");
  }
  // eslint-disable-next-line no-new-func
  return new Function(
    `return \`${match[1].replace(/`/g, "\\`")}\`;`,
  )() as string;
}

// Build a clean env: strip ambient AUTOLOOP_* that could leak from the host
// shell or a CI runner and change log paths / behavior mid-test.
function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("AUTOLOOP_")) base[k] = v;
  }
  return { ...base, ...overrides };
}

interface BridgeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  logContents: string | null;
  logFileName: string | null;
  stateDir: string;
}

function runBridge(
  fakePi: string,
  prompt: string,
  env: Record<string, string> = {},
  piPath?: string,
): BridgeResult {
  const script = loadBridgeScript();
  const work = mkdtempSync(join(tmpdir(), "autoloop-pi-bridge-"));
  const scriptPath = join(work, "bridge.py");
  const fakePath = join(work, "fake_pi.py");
  const promptPath = join(work, "prompt.md");
  const stateDir = join(work, "state");

  writeFileSync(scriptPath, script);
  writeFileSync(fakePath, fakePi);
  writeFileSync(promptPath, prompt);

  const pi = piPath ?? "python3";
  const piArgs = piPath ? [] : [fakePath];

  const start = Date.now();
  try {
    const result = spawnSync(
      "python3",
      [scriptPath, pi, ...piArgs, promptPath],
      {
        encoding: "utf-8",
        env: cleanEnv({
          AUTOLOOP_STATE_DIR: stateDir,
          ...env,
        }),
        timeout: 30_000,
      },
    );
    const durationMs = Date.now() - start;
    const reviewMode = env.AUTOLOOP_REVIEW_MODE === "hyperagent";
    const iteration = env.AUTOLOOP_ITERATION;
    const prefix = reviewMode ? "pi-review" : "pi-stream";
    const logFileName = `${prefix + (iteration ? `.${iteration}` : "")}.jsonl`;
    let logContents: string | null = null;
    try {
      logContents = readFileSync(join(stateDir, logFileName), "utf-8");
    } catch {
      logContents = null;
    }
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs,
      logContents,
      logFileName,
      stateDir,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("pi-adapter BRIDGE_SCRIPT", () => {
  it("returns success for clean pi exit with agent_end", () => {
    const fake = `
import json, sys
sys.stdin.read()
print(json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "hello"}}), flush=True)
print(json.dumps({"type": "agent_end", "messages": [{"content": [{"type":"text","text":"hello"}]}]}), flush=True)
sys.exit(0)
`;
    const result = runBridge(fake, "prompt");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.logContents ?? "").toContain("agent_end");
  });

  it("grace-kills pi that hangs after agent_end and treats it as success", () => {
    const fake = `
import json, sys, time
sys.stdin.read()
print(json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "done"}}), flush=True)
print(json.dumps({"type": "agent_end", "messages": [{"content": [{"type":"text","text":"done"}]}]}), flush=True)
time.sleep(120)
`;
    const result = runBridge(fake, "prompt", {
      AUTOLOOP_PI_POST_RESPONSE_GRACE_SEC: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("done");
    expect(result.durationMs).toBeLessThan(10_000);
    expect(result.logContents ?? "").toContain("agent_end");
  }, 15_000);

  it("grace-kills pi that hangs after turn_end (no agent_end)", () => {
    // Reviewer-mode pi may emit only turn_end and then hang the same way.
    // Regression: earlier revision of this fix only killed on agent_end.
    const fake = `
import json, sys, time
sys.stdin.read()
print(json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "reviewed"}}), flush=True)
print(json.dumps({"type": "turn_end", "message": {"content": [{"type":"text","text":"reviewed"}]}}), flush=True)
time.sleep(120)
`;
    const result = runBridge(fake, "prompt", {
      AUTOLOOP_PI_POST_RESPONSE_GRACE_SEC: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reviewed");
    expect(result.durationMs).toBeLessThan(10_000);
    expect(result.logContents ?? "").toContain("turn_end");
  }, 15_000);

  it("grace=0 kills immediately after agent_end", () => {
    const fake = `
import json, sys, time
sys.stdin.read()
print(json.dumps({"type": "agent_end", "messages": [{"content": [{"type":"text","text":"fast"}]}]}), flush=True)
time.sleep(120)
`;
    const result = runBridge(fake, "prompt", {
      AUTOLOOP_PI_POST_RESPONSE_GRACE_SEC: "0",
    });
    expect(result.status).toBe(0);
    expect(result.durationMs).toBeLessThan(5_000);
  }, 10_000);

  it("reports failure when pi exits nonzero without agent_end", () => {
    const fake = `
import sys
sys.stdin.read()
print("garbage line", flush=True)
sys.exit(3)
`;
    const result = runBridge(fake, "prompt");
    expect(result.status).toBe(1);
  });

  it("reports failure when pi emits an error event even with agent_end", () => {
    const fake = `
import json, sys
sys.stdin.read()
print(json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "error", "reason": "boom"}}), flush=True)
print(json.dumps({"type": "agent_end", "messages": [{"content": [{"type":"text","text":""}]}]}), flush=True)
sys.exit(0)
`;
    const result = runBridge(fake, "prompt");
    expect(result.status).toBe(1);
  });

  it("writes to pi-review.jsonl in hyperagent review mode", () => {
    const fake = `
import json, sys
sys.stdin.read()
print(json.dumps({"type": "turn_end", "message": {"content": [{"type":"text","text":"review"}]}}), flush=True)
sys.exit(0)
`;
    const result = runBridge(fake, "prompt", {
      AUTOLOOP_REVIEW_MODE: "hyperagent",
    });
    expect(result.status).toBe(0);
    expect(result.logFileName).toBe("pi-review.jsonl");
    expect(result.logContents ?? "").toContain("turn_end");
  });

  it("returns exit_code 127 when pi binary is missing", () => {
    const result = runBridge(
      "unused",
      "prompt",
      {},
      "/nonexistent/path/to/pi-binary-that-does-not-exist",
    );
    // Bridge reports failed=True → exit 1 to caller; raw_output has the error.
    expect(result.status).toBe(1);
    expect((result.stdout ?? "").length).toBeGreaterThan(0);
  });

  it("streams output to the log file incrementally", () => {
    const fake = `
import json, sys, time
sys.stdin.read()
print(json.dumps({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "a"}}), flush=True)
print(json.dumps({"type": "agent_end", "messages": [{"content": [{"type":"text","text":"a"}]}]}), flush=True)
for i in range(3):
    print(f"noise {i}", flush=True)
    time.sleep(0.1)
time.sleep(60)
`;
    const result = runBridge(fake, "prompt", {
      AUTOLOOP_PI_POST_RESPONSE_GRACE_SEC: "1",
    });
    expect(result.status).toBe(0);
    const log = result.logContents ?? "";
    expect(log).toContain("agent_end");
    expect(log).toContain("noise");
  }, 15_000);
});
