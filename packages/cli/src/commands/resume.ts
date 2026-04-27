/**
 * CLI: autoloop resume <run-id> [--add-iterations N] [-b <backend>] [-v]
 */

import { resume, validateResume } from "@mobrienv/autoloop-harness/resume";
import { cliPrintEvent } from "../cli/event-printer.js";

interface ResumeCliOptions {
  runIdOrPrefix: string;
  addIterations?: number;
  backendOverride: Record<string, unknown>;
  logLevel: string | null;
}

export async function dispatchResume(
  args: string[],
  selfCmd: string,
): Promise<boolean> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printResumeUsage();
    return true;
  }

  const options = parseResumeArgs(args);

  // Install signal handlers
  const abort = new AbortController();
  let caughtSignal: NodeJS.Signals | null = null;
  const onSig = (sig: NodeJS.Signals) => {
    if (caughtSignal) return;
    caughtSignal = sig;
    abort.abort();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  try {
    await resume(options.runIdOrPrefix, selfCmd, {
      addIterations: options.addIterations,
      backendOverride:
        Object.keys(options.backendOverride).length > 0
          ? options.backendOverride
          : undefined,
      logLevel: options.logLevel,
      signal: abort.signal,
      onEvent: cliPrintEvent,
    });
  } finally {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
    if (caughtSignal) process.kill(process.pid, caughtSignal);
  }

  return true;
}

function parseResumeArgs(args: string[]): ResumeCliOptions {
  const options: ResumeCliOptions = {
    runIdOrPrefix: "",
    backendOverride: {},
    logLevel: null,
  };

  let i = 0;
  while (i < args.length) {
    const token = args[i];

    if (token === "--verbose" || token === "-v") {
      options.logLevel = "debug";
      i++;
      continue;
    }

    if (token === "-b" || token === "--backend") {
      const backend = args[i + 1];
      if (backend) {
        options.backendOverride.command = backend;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (token === "--add-iterations") {
      const val = parseInt(args[i + 1], 10);
      if (!Number.isNaN(val) && val > 0) {
        options.addIterations = val;
        i += 2;
      } else {
        console.error(
          `Invalid --add-iterations value: ${args[i + 1]} (must be positive integer)`,
        );
        i += 2;
      }
      continue;
    }

    // First positional is the run ID
    if (!options.runIdOrPrefix) {
      options.runIdOrPrefix = token;
    }

    i++;
  }

  return options;
}

function printResumeUsage(): void {
  console.log(`
Usage: autoloop resume <run-id> [flags]

Resume a previously-terminated run from where it left off.

Arguments:
  <run-id>              Full or prefix match of the run to resume

Flags:
  --add-iterations N    Additional iterations to grant (default: original max_iterations)
  -b, --backend <cmd>   Override backend command
  -v, --verbose         Debug-level logging
  -h, --help            Show this help

Examples:
  autoloop resume swift-wave
  autoloop resume swift-wave --add-iterations 10
  autoloop resume swift-wave -b pi -v

Notes:
  - Reuses the original run_id, journal, and state directory
  - Auto-stashes any dirty working tree from the crashed run
  - Cannot resume completed runs or currently running runs
  - Worktree runs reattach to the existing worktree
`);
}
