import { listText } from "@mobrienv/autoloop-core";
import {
  appendEvent,
  extractField,
  extractIteration,
  extractTopic,
  readRunLines,
} from "@mobrienv/autoloop-core/journal";
import {
  runKiroIterationSync,
  setKiroSessionMode,
} from "./backend/kiro-bridge.js";
import { log } from "./display.js";
import {
  appendInvalidEvent,
  invalidEvent,
  parallelTriggerTopic,
  systemTopic,
} from "./emit.js";
import {
  captureEvidence,
  evidenceToJournalPayload,
  renderEvidencePrompt,
  renderGateFailurePrompt,
} from "./evidence.js";
import type { IterationEvidence } from "./evidence.js";
import {
  appendBackendFinish,
  appendBackendStart,
  appendIterationFinish,
  appendIterationStart,
  buildBackendCommand,
  runProcess,
} from "./parallel.js";
import type { IterationContext } from "./prompt.js";
import { buildIterationContext } from "./prompt.js";
import { registryProgress } from "./registry-bridge.js";
import { completeLoop, stopBackendFailed, stopBackendTimeout } from "./stop.js";
import type { LoopContext, RunSummary } from "./types.js";
import {
  continueAfterParallelJoin,
  executeParallelWave,
  stopAfterParallelWave,
} from "./wave.js";

export function runIteration(
  loop: LoopContext,
  iteration: number,
  iterate: (loop: LoopContext, iteration: number) => RunSummary,
): RunSummary {
  const iter = buildIterationContext(loop, iteration);
  loop.onEvent?.({
    type: "iteration.banner",
    iteration: iter.iteration,
    maxIterations: loop.limits.maxIterations,
    allowedRoles: iter.allowedRoles,
    recentEvent: iter.recentEvent,
    allowedEvents: iter.allowedEvents,
    lastRejected: iter.lastRejected,
  });
  appendIterationStart(loop, iter);
  log(loop, "debug", `iteration ${iteration} start`);
  appendBackendStart(loop, iter);
  log(loop, "debug", `backend start command=${loop.backend.command}`);

  const startEpoch = Math.floor(Date.now() / 1000);

  // Switch Kiro session agent mode per-role if agents.toml provides a mapping
  if (iter.roleAgent && loop.backend.kind === "kiro" && loop.kiroSession) {
    log(
      loop,
      "debug",
      `switching kiro agent to "${iter.roleAgent}" for role "${iter.allowedRoles[0]}"`,
    );
    setKiroSessionMode(loop.kiroSession, iter.roleAgent);
  }

  const { output, exitCode, timedOut } =
    loop.backend.kind === "kiro" && loop.kiroSession
      ? runKiroIterationSync(
          loop.kiroSession,
          iter.prompt,
          loop.backend.timeoutMs,
        )
      : runProcess(
          buildBackendCommand(loop, iter),
          loop.backend.timeoutMs,
          loop.backend.kind,
        );
  const elapsedS = Math.floor(Date.now() / 1000) - startEpoch;

  appendBackendFinish(loop, iter, output, exitCode, timedOut);
  appendIterationFinish(loop, iter, output, exitCode, timedOut, elapsedS);
  registryProgress(loop, iteration);
  log(loop, "debug", `iteration ${iteration} finish exit_code=${exitCode}`);
  loop.onEvent?.({
    type: "iteration.footer",
    iteration: iter.iteration,
    elapsedS,
  });
  loop.onEvent?.({ type: "backend.output", output });

  if (timedOut) return stopBackendTimeout(loop, iteration, output);
  if (exitCode !== 0) return stopBackendFailed(loop, iteration, output);

  // Capture harness evidence after successful backend execution
  let evidence: IterationEvidence | undefined;
  if (loop.evidence?.enabled && loop.evidence.sources.length > 0) {
    const activeRole =
      iter.allowedRoles.length === 1 ? iter.allowedRoles[0] : "unknown";
    evidence = captureEvidence(
      loop.evidence,
      loop.paths.workDir,
      loop.paths.stateDir,
      iteration,
      activeRole,
    );

    // Journal the evidence capture
    appendEvent(
      loop.paths.journalFile,
      loop.runtime.runId,
      String(iteration),
      "evidence.captured",
      evidenceToJournalPayload(evidence),
    );
    log(
      loop,
      "debug",
      `evidence captured: ${evidence.results.length} sources, gate=${evidence.overall_gate_passed}`,
    );

    // If a gate failed, handle the failure instead of routing normally
    if (!evidence.overall_gate_passed) {
      const gateRetries = countConsecutiveGateRetries(
        readRunLines(loop.paths.journalFile, loop.runtime.runId),
      );
      if (gateRetries >= loop.evidence.max_gate_retries) {
        log(
          loop,
          "warn",
          `evidence gate exhausted after ${gateRetries} retries`,
        );
        appendEvent(
          loop.paths.journalFile,
          loop.runtime.runId,
          String(iteration),
          "evidence.gate_exhausted",
          `retries=${gateRetries}`,
        );
        // Fall through to normal routing — let the critic see the failures
      } else {
        appendEvent(
          loop.paths.journalFile,
          loop.runtime.runId,
          String(iteration),
          "evidence.gate_failed",
          evidenceToJournalPayload(evidence),
        );
        log(
          loop,
          "info",
          `[gate] evidence check failed, retry ${gateRetries + 1}/${loop.evidence.max_gate_retries}`,
        );
        loop.onEvent?.({
          type: "progress",
          runId: loop.runtime.runId,
          iteration: iter.iteration,
          recentEvent: iter.recentEvent,
          allowedRoles: iter.allowedRoles,
          emittedTopic: "evidence.gate_failed",
          outcome: "retry:evidence_gate",
        });
        // Store gate failure prompt for next iteration's injection
        loop.lastGateFailure = renderGateFailurePrompt(evidence);
        return iterate(loop, iter.iteration + 1);
      }
    }
  }

  // Store evidence for prompt injection into next iteration
  if (evidence) {
    loop.lastEvidence = renderEvidencePrompt(evidence);
  }

  return finishIteration(loop, iter, output, iterate);
}

export function finishIteration(
  loop: LoopContext,
  iter: IterationContext,
  output: string,
  iterate: (loop: LoopContext, iteration: number) => RunSummary,
): RunSummary {
  const runLines = readRunLines(loop.paths.journalFile, loop.runtime.runId);
  const allTopics = runLines.map(extractTopic).filter((t) => t !== "");
  const turnLines = runLines.filter(
    (l) => extractIteration(l) === String(iter.iteration),
  );
  const emitted = latestAgentEventRecord(turnLines);
  const hadInvalidEvents = turnLines.some(
    (l) => extractTopic(l) === "event.invalid",
  );

  const progress = (emittedTopic: string, outcome: string) =>
    loop.onEvent?.({
      type: "progress",
      runId: loop.runtime.runId,
      iteration: iter.iteration,
      recentEvent: iter.recentEvent,
      allowedRoles: iter.allowedRoles,
      emittedTopic,
      outcome,
    });

  if (
    invalidEvent(
      emitted.topic,
      iter.allowedEvents,
      loop.parallel.enabled,
      loop.completion.event,
    )
  ) {
    return rejectInvalidAndContinue(
      loop,
      iter,
      emitted.topic,
      iterate,
      progress,
    );
  }

  if (parallelTriggerTopic(emitted.topic)) {
    return finishParallelIteration(
      loop,
      iter,
      emitted.topic,
      emitted.payload,
      iterate,
      progress,
    );
  }

  const resolved = resolveOutcome({
    emittedTopic: emitted.topic,
    allTopics,
    hadInvalidEvents,
    output,
    completionEvent: loop.completion.event,
    requiredEvents: loop.completion.requiredEvents,
    completionPromise: loop.completion.promise,
  });

  progress(emitted.topic, resolved.outcome);

  if (resolved.action === "complete_event")
    return completeLoop(loop, iter.iteration, "completion_event");
  if (resolved.action === "complete_promise")
    return completeLoop(loop, iter.iteration, "completion_promise");
  return iterate(loop, iter.iteration + 1);
}

function rejectInvalidAndContinue(
  loop: LoopContext,
  iter: IterationContext,
  emittedTopic: string,
  iterate: (loop: LoopContext, iteration: number) => RunSummary,
  progress: (topic: string, outcome: string) => void,
): RunSummary {
  appendInvalidEvent(
    loop.paths.journalFile,
    loop.runtime.runId,
    String(iter.iteration),
    iter.recentEvent,
    emittedTopic,
    iter.allowedRoles,
    iter.allowedEvents,
  );
  log(
    loop,
    "info",
    `[reject] invalid event \`${emittedTopic}\`; recent event: \`${iter.recentEvent}\`; allowed next events: ${listText(iter.allowedEvents)}`,
  );
  progress(emittedTopic, "rejected:event.invalid");
  return iterate(loop, iter.iteration + 1);
}

function finishParallelIteration(
  loop: LoopContext,
  iter: IterationContext,
  emittedTopic: string,
  emittedPayload: string,
  iterate: (loop: LoopContext, iteration: number) => RunSummary,
  progress: (topic: string, outcome: string) => void,
): RunSummary {
  const result = executeParallelWave(loop, iter, emittedTopic, emittedPayload);

  if (result.reason === "parallel_wave_complete") {
    progress(emittedTopic, "parallel:joined");
    return continueAfterParallelJoin(
      loop,
      iter,
      result.waveId,
      emittedTopic,
      result.elapsedMs,
      iterate,
    );
  }
  progress(emittedTopic, `parallel:stop:${result.reason}`);
  return stopAfterParallelWave(loop, iter, result.reason, result.waveId);
}

export function resolveOutcome(ctx: {
  emittedTopic: string;
  allTopics: string[];
  hadInvalidEvents: boolean;
  output: string;
  completionEvent: string;
  requiredEvents: string[];
  completionPromise: string;
}): { action: string; outcome: string } {
  if (
    completedViaEvent(ctx.allTopics, ctx.completionEvent, ctx.requiredEvents)
  ) {
    return { action: "complete_event", outcome: "complete:completion_event" };
  }
  if (shouldContinueFromAcceptedEvent(ctx.emittedTopic, ctx.completionEvent)) {
    return { action: "continue_routed", outcome: "continue:routed_event" };
  }
  if (
    !ctx.hadInvalidEvents &&
    completedViaPromise(ctx.output, ctx.completionPromise)
  ) {
    return {
      action: "complete_promise",
      outcome: "complete:completion_promise",
    };
  }
  return { action: "continue", outcome: "continue" };
}

function latestAgentEventRecord(lines: string[]): {
  topic: string;
  payload: string;
} {
  for (let i = lines.length - 1; i >= 0; i--) {
    const topic = extractTopic(lines[i]);
    if (!systemTopic(topic)) {
      return { topic, payload: extractField(lines[i], "payload") };
    }
  }
  return { topic: "", payload: "" };
}

function completedViaEvent(
  topics: string[],
  completionEvent: string,
  requiredEvents: string[],
): boolean {
  if (!topics.includes(completionEvent)) return false;
  return requiredEvents.every((e) => topics.includes(e));
}

function completedViaPromise(output: string, promise: string): boolean {
  if (!promise) return false;
  return output.includes(promise);
}

function shouldContinueFromAcceptedEvent(
  emittedTopic: string,
  completionEvent: string,
): boolean {
  if (!emittedTopic) return false;
  return emittedTopic !== completionEvent;
}

/**
 * Count how many consecutive evidence.gate_failed events occurred at the
 * tail of the run journal. Resets when any non-evidence-gate event appears.
 */
function countConsecutiveGateRetries(runLines: string[]): number {
  let count = 0;
  for (let i = runLines.length - 1; i >= 0; i--) {
    const topic = extractTopic(runLines[i]);
    if (topic === "evidence.gate_failed") {
      count++;
    } else if (topic === "evidence.captured" || topic === "evidence.gate_exhausted") {
      // Part of the evidence system but not a retry — continue scanning
      continue;
    } else if (!coreSystemTopic(topic)) {
      // Non-system, non-evidence topic — break the streak
      break;
    }
  }
  return count;
}

function coreSystemTopic(topic: string): boolean {
  return (
    topic === "iteration.start" ||
    topic === "iteration.finish" ||
    topic === "backend.start" ||
    topic === "backend.finish" ||
    topic.startsWith("wave.")
  );
}
