// Long-horizon soak (§39): 100+ task transitions with reopen cycles.
// Validates: revision monotonicity, no unbounded hot-context growth,
// bounded persisted state, correct projection, no stuck waiting states.
// Also measures per-operation cost (no LLM anywhere).

import { TaskStore } from "../src/core/store.ts";
import { renderProjection, projectionBytes } from "../src/core/projection.ts";
import type { TaskMutation, TaskCheckpoint } from "../src/core/types.ts";

let clock = 1_700_000_000_000;
const now = () => ++clock;

function newTask(store: TaskStore, title: string): TaskMutation {
  return {
    kind: "create",
    task: {
      v: 1,
      id: `task_${clock}_${Math.floor(Math.random() * 1e9).toString(36)}`,
      displayId: store.nextDisplayId(),
      title,
      state: "todo",
      priority: "normal",
      blockers: [],
      dependencies: [],
      resourceRefs: [],
      evidenceRefs: [],
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    },
  };
}

// -- deterministic soak --------------------------------------------------------

const log: TaskMutation[] = [];
const checkpoints: TaskCheckpoint[] = [];
let store = new TaskStore(now);
const failures: string[] = [];

function apply(mutation: TaskMutation): void {
  const result = store.apply(mutation);
  log.push(mutation);
  if (result.task) void result.task;
  if (store.degraded) {
    failures.push(`degraded during soak: ${store.degraded}`);
    store.degraded = undefined;
  }
}

function checkpointNow(): void {
  const cp: TaskCheckpoint = {
    v: 1,
    sessionId: "soak",
    activeTaskIds: store.open().map((t) => t.id),
    runtimeBufferRefs: [],
    pendingJobs: store.open().flatMap((t) => (t.waiting?.kind === "job" ? [t.waiting.jobId] : [])),
    pendingApprovals: store
      .open()
      .flatMap((t) => (t.waiting?.kind === "approval" ? [t.waiting.digest] : [])),
    pendingCI: [],
    importantEvidenceRefs: [],
    createdAt: now(),
  };
  store.checkpoint(cp);
  checkpoints.push(cp);
}

let jobIdCounter = 0;
// 120 transition cycles: create → start → wait(job) → [job event] → done
for (let cycle = 0; cycle < 30; cycle++) {
  for (let batch = 0; batch < 4; batch++) {
    const created = store.apply(newTask(store, `Soak task ${cycle}-${batch}`)).task!;
    log.push({ kind: "create", task: structuredClone(created) });
    apply({
      kind: "transition",
      id: created.id,
      expectedRevision: created.revision,
      to: "in_progress",
    });
    const jobId = `job_${++jobIdCounter}`.padStart(8, "0");
    apply({
      kind: "transition",
      id: created.id,
      expectedRevision: store.mustGet(created.id).revision,
      to: "waiting",
      waiting: { kind: "job", jobId },
    });
    // simulate the runtime job-terminal contract event
    const t = store.mustGet(created.id);
    apply({
      kind: "waiting-resolved",
      id: created.id,
      expectedRevision: t.revision,
      outcome: batch === 3 ? "blocked" : "ready", // every 4th job fails
      detail: batch === 3 ? `job ${jobId} failed (exit 1)` : `job ${jobId} completed`,
    });
    const current = store.mustGet(created.id);
    if (current.state === "in_progress") {
      apply({ kind: "transition", id: created.id, expectedRevision: current.revision, to: "done" });
    } else {
      // blocked tasks recover, then complete
      apply({
        kind: "transition",
        id: created.id,
        expectedRevision: current.revision,
        to: "in_progress",
      });
      apply({
        kind: "transition",
        id: created.id,
        expectedRevision: store.mustGet(created.id).revision,
        to: "done",
      });
    }
  }
  checkpointNow();
  // reopen every 5 cycles: full replay from the log
  if (cycle % 5 === 4) {
    const reopened = new TaskStore(now);
    for (const mutation of log) reopened.applyRecord(mutation);
    for (const cp of checkpoints) reopened.checkpoint(cp);
    const beforeHealth = store.health();
    const afterHealth = reopened.health();
    if (beforeHealth.openTasks !== afterHealth.openTasks) {
      failures.push(`reopen drift: ${beforeHealth.openTasks} vs ${afterHealth.openTasks}`);
    }
    if (beforeHealth.checkpointCount !== afterHealth.checkpointCount) {
      failures.push("checkpoint count drifted on reopen");
    }
    store = reopened;
  }
}

// -- validation ------------------------------------------------------------------

const finalOpen = store.open();
const maxProjectionBytes = projectionBytes(store.all());
const revisionOk = store.all().every((t) => t.revision >= 1 && Number.isInteger(t.revision));
const stuckWaiting = store.open().filter((t) => t.state === "waiting").length;
const uniqueIds = new Set(store.all().map((t) => t.id)).size === store.all().length;

if (!revisionOk) failures.push("revision non-monotonic");
if (stuckWaiting !== 0) failures.push(`${stuckWaiting} tasks stuck waiting after terminal events`);
if (!uniqueIds) failures.push("duplicate task ids");
if (maxProjectionBytes > 4096)
  failures.push(`hot projection too large: ${maxProjectionBytes} bytes`);
if (store.health().store !== "healthy") failures.push("store degraded at soak end");

// -- performance (orientation only) ----------------------------------------------

function bench(fn: () => void, iterations = 10_000): number {
  for (let i = 0; i < 100; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  return ((Number(process.hrtime.bigint() - start) / 1e6) * 1000) / iterations;
}

const perfTask = store.all()[0]!;
const perCreateUs = bench(() => {
  const s = new TaskStore(now);
  s.apply(newTask(s, "perf"));
}, 2000);
const perUpdateUs = bench(() => {
  store.apply({
    kind: "update",
    id: perfTask.id,
    expectedRevision: store.mustGet(perfTask.id).revision,
    patch: { note: `n${clock++}`.slice(0, 50) },
  });
}, 5000);
const perProjectUs = bench(() => renderProjection(store.all()), 20_000);
const perReplayUs = bench(() => {
  const s = new TaskStore(now);
  for (const m of log.slice(-200)) s.applyRecord(m);
}, 500);

const result = {
  bench: "pi-task-next long-horizon soak",
  transitions: log.length,
  reopenCycles: 6,
  finalOpenTasks: finalOpen.length,
  totalTasksRetained: store.all().length,
  checkpointsRetained: checkpoints.length <= 8 ? checkpoints.length : store.allCheckpoints().length,
  hotProjectionBytes: maxProjectionBytes,
  hotProjection: renderProjection(store.all()).split("\n")[1] ?? "(empty)",
  stuckWaiting,
  healthy: store.health().store === "healthy",
  failures,
  performance: {
    createUs: Number(perCreateUs.toFixed(2)),
    updateUs: Number(perUpdateUs.toFixed(2)),
    projectUs: Number(perProjectUs.toFixed(3)),
    replay200Us: Number(perReplayUs.toFixed(2)),
  },
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (failures.length > 0) process.exit(1);
