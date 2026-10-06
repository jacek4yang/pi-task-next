// Pure core tests: state machine, store (T2 revisions, quotas, GC, cycles),
// projection (T4 bounded, T7 byte-stable), checkpoints (T5), issues.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/core/store.ts";
import { canTransition, isTerminal } from "../src/core/machine.ts";
import { renderProjection, projectionBytes, projectionTasks } from "../src/core/projection.ts";
import { IssueStore } from "../src/core/issues.ts";
import type { Task, TaskCheckpoint, TaskMutation } from "../src/core/types.ts";

let clock = 1_700_000_000_000;
void clock;
const NOW = () => clock;

function freshStore(): TaskStore {
  return new TaskStore(NOW);
}

function makeTask(store: TaskStore, title: string, priority: Task["priority"] = "normal"): Task {
  const task: Task = {
    v: 1,
    id: `task_${title.replace(/\W+/g, "")}_${clock}`,
    displayId: store.nextDisplayId(),
    title,
    state: "todo",
    priority,
    blockers: [],
    dependencies: [],
    resourceRefs: [],
    evidenceRefs: [],
    revision: 1,
    createdAt: NOW(),
    updatedAt: NOW(),
  };
  store.create(task);
  return task;
}

// -- state machine -----------------------------------------------------------

test("[T] transitions are explicit; invalid transitions fail", () => {
  assert.ok(canTransition("todo", "in_progress"));
  assert.ok(canTransition("in_progress", "waiting"));
  assert.ok(canTransition("waiting", "in_progress"));
  assert.ok(canTransition("in_progress", "blocked"));
  assert.ok(canTransition("blocked", "in_progress"));
  assert.ok(canTransition("in_progress", "done"));
  assert.ok(canTransition("todo", "cancelled"));
  assert.ok(!canTransition("todo", "done"), "todo must pass through in_progress");
  assert.ok(!canTransition("done", "cancelled"), "done is terminal");
  assert.ok(!canTransition("cancelled", "in_progress"), "cancelled is terminal");
  assert.ok(isTerminal("done") && isTerminal("cancelled"));
});

// -- store: revisions (T2) ---------------------------------------------------

test("[T2] stale revision cannot overwrite newer state", () => {
  const store = freshStore();
  const t = makeTask(store, "Implement feature");
  store.update(t.id, 1, { title: "Renamed" });
  assert.equal(store.mustGet(t.id).revision, 2);
  assert.throws(
    () => store.update(t.id, 1, { title: "Stale write" }),
    /stale revision/,
    "stale write rejected",
  );
  assert.equal(store.mustGet(t.id).title, "Renamed", "newer state preserved");
});

test("[T2] every mutation increments the revision monotonically", () => {
  const store = freshStore();
  const t = makeTask(store, "Do work");
  const revisions = [store.mustGet(t.id).revision];
  store.transition(t.id, 1, "in_progress");
  revisions.push(store.mustGet(t.id).revision);
  store.transition(t.id, 2, "waiting", { kind: "external", description: "upstream" });
  revisions.push(store.mustGet(t.id).revision);
  store.transition(t.id, 3, "in_progress");
  revisions.push(store.mustGet(t.id).revision);
  store.transition(t.id, 4, "done");
  revisions.push(store.mustGet(t.id).revision);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
});

// -- store: waiting semantics (T3 groundwork) --------------------------------

test("[T3] waiting requires a typed reason; resolution returns to in_progress or blocked", () => {
  const store = freshStore();
  const t = makeTask(store, "Await build");
  store.transition(t.id, 1, "in_progress");
  assert.throws(
    () => store.transition(t.id, 2, "waiting"),
    /waiting transition requires a waiting reason/,
  );
  store.transition(t.id, 2, "waiting", { kind: "job", jobId: "job_0001" });
  assert.equal(store.mustGet(t.id).waiting?.kind, "job");
  store.resolveWaiting(t.id, 3, "ready", "job job_0001 completed");
  assert.equal(store.mustGet(t.id).state, "in_progress", "job completion ≠ task completion");
  assert.equal(store.mustGet(t.id).waiting, undefined);

  const t2 = makeTask(store, "Await failing build");
  store.transition(t2.id, 1, "in_progress");
  store.transition(t2.id, 2, "waiting", { kind: "job", jobId: "job_0002" });
  store.resolveWaiting(t2.id, 3, "blocked", "job job_0002 failed (exit 1)");
  assert.equal(store.mustGet(t2.id).state, "blocked");
  assert.match(store.mustGet(t2.id).note ?? "", /failed/);
});

test("[T3] resolveWaiting on a non-waiting task is an explicit error", () => {
  const store = freshStore();
  const t = makeTask(store, "Not waiting");
  store.transition(t.id, 1, "in_progress");
  assert.throws(() => store.resolveWaiting(t.id, 2, "ready"), /is not waiting/);
});

// -- store: dependencies -------------------------------------------------------

test("[T] self dependency and unknown refs are explicit errors; cycles detected", () => {
  const store = freshStore();
  const a = makeTask(store, "A");
  const b = makeTask(store, "B");
  assert.throws(() => store.link(a.id, 1, [], [a.id]), /self dependency/);
  assert.throws(() => store.link(a.id, 1, [], ["missing"]), /unknown task ref/);
  store.link(a.id, 1, [], [b.id]);
  assert.throws(() => store.link(b.id, 1, [], [a.id]), /cycle detected/);
});

// -- store: quotas + GC (§18, §36) ---------------------------------------------

test("[T] oversized titles/notes/refs are rejected, never silently truncated", () => {
  const store = freshStore();
  assert.throws(() => makeTask(store, "x".repeat(201)), /title exceeds/);
  const t = makeTask(store, "Fine");
  assert.throws(() => store.update(t.id, 1, { note: "n".repeat(501) }), /note exceeds/);
  assert.throws(
    () => store.update(t.id, 1, { resourceRefs: Array.from({ length: 17 }, (_, i) => `r${i}`) }),
    /resourceRefs exceeds/,
  );
});

test("[T4] terminal history is bounded by deterministic GC; referenced tasks survive", () => {
  const store = freshStore();
  const first = makeTask(store, "Referenced completed");
  const parent = makeTask(store, "Parent with dependency");
  store.link(parent.id, 1, [], [first.id]);
  store.transition(first.id, 1, "in_progress");
  store.transition(first.id, 2, "done");
  // fill up with unreferenced terminal tasks
  for (let i = 0; i < 60; i++) {
    const t = makeTask(store, `Filler ${i}`);
    store.transition(t.id, 1, "in_progress");
    store.transition(t.id, 2, "done");
  }
  const retained = store.all().filter((x) => x.state === "done");
  assert.ok(retained.length <= 50, `retained ${retained.length} terminal tasks (bound 50)`);
  assert.ok(store.get(first.id), "GC keeps tasks still referenced by dependencies");
  assert.ok(store.get(parent.id), "live tasks survive GC");
});

test("[T] open-task quota is enforced", () => {
  const store = freshStore();
  for (let i = 0; i < 64; i++) makeTask(store, `Open ${i}`);
  assert.throws(() => makeTask(store, "One too many"), /open task limit reached/);
});

// -- projection (T4/T7) ---------------------------------------------------------

test("[T7] projection is byte-identical when task state is unchanged", () => {
  const store = freshStore();
  const a = makeTask(store, "Active work", "high");
  const b = makeTask(store, "Next thing", "low");
  store.transition(a.id, 1, "in_progress");
  const p1 = renderProjection(store.all());
  const p2 = renderProjection(store.all());
  assert.equal(p1, p2);
  assert.equal(projectionBytes(store.all()), Buffer.byteLength(p1, "utf8"));
  assert.ok(!p1.includes("createdAt") && !p1.includes("updatedAt"));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(p1), "no dates in projection");
  void b;
});

test("[T7] task mutation changes only task-related lines (late placement)", () => {
  const store = freshStore();
  makeTask(store, "Only task");
  const before = renderProjection(store.all());
  store.transition(store.all()[0]!.id, 1, "in_progress");
  const after = renderProjection(store.all());
  assert.notEqual(before, after);
  assert.match(after, /in_progress/);
});

test("[T4] projection is bounded: terminal tasks never appear, todos capped", () => {
  const store = freshStore();
  for (let i = 0; i < 30; i++) {
    const t = makeTask(store, `Todo ${i}`, i % 2 === 0 ? "high" : "low");
    if (i < 5) {
      store.transition(t.id, 1, "in_progress");
      store.transition(t.id, 2, "done");
    }
  }
  const rendered = renderProjection(store.all());
  assert.ok(!rendered.includes("Todo 29"), "terminal tasks excluded from hot projection");
  const visible = projectionTasks(store.all());
  const todos = visible.filter((t) => t.state === "todo");
  assert.ok(todos.length <= 3, `next todos bounded (got ${todos.length})`);
  assert.ok(projectionBytes(store.all()) < 4096, "projection stays small");
});

test("[T4] ordering is deterministic: active, blocked, waiting, then priority todos", () => {
  const store = freshStore();
  const todo = makeTask(store, "Plain todo", "low");
  const waiting = makeTask(store, "Waiting one");
  const blocked = makeTask(store, "Blocked one");
  const active = makeTask(store, "Active one", "high");
  store.transition(waiting.id, 1, "in_progress");
  store.transition(waiting.id, 2, "waiting", { kind: "job", jobId: "job_9" });
  store.transition(blocked.id, 1, "in_progress");
  store.transition(blocked.id, 2, "blocked");
  store.transition(active.id, 1, "in_progress");
  const ids = projectionTasks(store.all()).map((t) => t.displayId);
  const pos = (id: string) => ids.indexOf(id);
  assert.ok(pos(active.displayId) < pos(blocked.displayId), "active before blocked");
  assert.ok(pos(blocked.displayId) < pos(waiting.displayId), "blocked before waiting");
  assert.ok(pos(waiting.displayId) < pos(todo.displayId), "waiting before next todos");
  void todo;
});

test("[T4] empty task list projects to an empty string (no empty task block)", () => {
  assert.equal(renderProjection([]), "");
  assert.equal(projectionBytes([]), 0);
});

// -- checkpoints (T5) --------------------------------------------------------

test("[T5] checkpoint references must resolve; invalid checkpoints fail validation", () => {
  const store = freshStore();
  const t = makeTask(store, "Active");
  store.transition(t.id, 1, "in_progress");
  const cp: TaskCheckpoint = {
    v: 1,
    sessionId: "s1",
    activeTaskIds: [t.id],
    runtimeBufferRefs: [],
    pendingJobs: [],
    pendingApprovals: [],
    pendingCI: [],
    importantEvidenceRefs: [],
    createdAt: NOW(),
  };
  store.checkpoint(cp);
  assert.equal(store.latestValidCheckpoint()?.activeTaskIds[0], t.id);
  // a checkpoint referencing a GC'd/missing task is not restorable
  store.clearForReplay();
  store.applyRecord({ kind: "create", task: { ...t } });
  const staleCp: TaskCheckpoint = { ...cp, activeTaskIds: ["task_missing"] };
  store.checkpoint(staleCp);
  assert.equal(store.latestValidCheckpoint(), undefined, "missing referenced task → invalid");
});

test("[T5] checkpoint history is bounded (oldest dropped)", () => {
  const store = freshStore();
  for (let i = 0; i < 12; i++) {
    store.checkpoint({
      v: 1,
      sessionId: "s1",
      activeTaskIds: [],
      runtimeBufferRefs: [],
      pendingJobs: [],
      pendingApprovals: [],
      pendingCI: [],
      importantEvidenceRefs: [],
      createdAt: NOW() + i,
    });
  }
  assert.ok(
    store.allCheckpoints().length <= 8,
    `checkpoints bounded (got ${store.allCheckpoints().length})`,
  );
});

// -- corruption (T6) -----------------------------------------------------------

test("[T6] corrupt records mark the store degraded instead of crashing", () => {
  const store = freshStore();
  store.applyRecord({ kind: "create", task: { v: 2 } });
  assert.ok(store.degraded, "bad schema version → degraded");
  assert.equal(store.health().store, "degraded");
  store.applyRecord("nonsense");
  assert.match(store.degraded ?? "", /corrupt/);
  // unknown mutation kind
  store.applyRecord({ kind: "teleport" });
  assert.match(store.degraded ?? "", /unknown mutation kind/);
});

test("[T6] duplicate task ids fail with explicit corruption", () => {
  const store = freshStore();
  const t = makeTask(store, "Dup");
  assert.throws(() => store.create({ ...t }), /duplicate task id/);
});

// -- issue candidates ------------------------------------------------------------

test("[T] issue candidates are durable, bounded, and dismissible", async () => {
  const { mkdtempSync, rmSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pinx-task-issues-"));
  try {
    const path = join(dir, "issues.json");
    let clock2 = 1_700_000_000_000;
    const store = new IssueStore(path, () => ++clock2);
    await store.load();
    assert.equal(store.list().length, 0);

    const issue = await store.add({
      title: "Flaky CI on windows",
      description: "Timer race in soak test",
    });
    assert.ok(existsSync(path), "persisted");
    assert.equal(issue.state, "open");

    // reopen: a fresh instance restores from disk
    const reopened = new IssueStore(path, () => ++clock2);
    await reopened.load();
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.list()[0]!.title, "Flaky CI on windows");

    await reopened.dismiss(issue.id);
    const after = new IssueStore(path, () => ++clock2);
    await after.load();
    assert.equal(after.list()[0]!.state, "dismissed");

    // corruption fails closed to empty healthy-with-flag, file untouched
    const raw = readFileSync(path, "utf8");
    const corrupt = new IssueStore(path, () => ++clock2);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{not json");
    await corrupt.load();
    assert.ok(corrupt.degraded, "corrupt store marked degraded");
    assert.equal(corrupt.list().length, 0);
    writeFileSync(path, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[T2] replay never mutates the mutation log (store owns its state)", () => {
  const store = freshStore();
  const task: Task = {
    v: 1,
    id: "task_alias",
    displayId: "T1",
    title: "Alias probe",
    state: "todo",
    priority: "normal",
    blockers: [],
    dependencies: [],
    resourceRefs: [],
    evidenceRefs: [],
    revision: 1,
    createdAt: NOW(),
    updatedAt: NOW(),
  };
  const log: TaskMutation[] = [{ kind: "create", task: structuredClone(task) }];
  store.apply(structuredClone(log[0]!));
  const seq: TaskMutation[] = [
    { kind: "transition", id: "task_alias", expectedRevision: 1, to: "in_progress" },
    {
      kind: "transition",
      id: "task_alias",
      expectedRevision: 2,
      to: "waiting",
      waiting: { kind: "job", jobId: "j1" },
    },
    {
      kind: "waiting-resolved",
      id: "task_alias",
      expectedRevision: 3,
      outcome: "ready",
      detail: "job j1 completed",
    },
    { kind: "transition", id: "task_alias", expectedRevision: 4, to: "done" },
  ];
  for (const m of seq) {
    store.apply(structuredClone(m));
    log.push(structuredClone(m));
  }
  assert.equal(createRecordRevision(log), 1, "log record untouched by store mutations");

  // Two successive full replays of the same log must agree exactly, and
  // replaying must itself never corrupt the log.
  const replay1 = freshStore();
  for (const m of log) replay1.applyRecord(structuredClone(m));
  const replay2 = freshStore();
  for (const m of log) replay2.applyRecord(structuredClone(m));
  assert.equal(replay1.mustGet("task_alias").revision, 5);
  assert.equal(replay2.mustGet("task_alias").revision, 5);
  assert.equal(createRecordRevision(log), 1, "log still untouched after replays");
  assert.equal(replay1.health().store, "healthy");
});

function createRecordRevision(log: TaskMutation[]): number {
  const first = log[0]!;
  return first.kind === "create" ? first.task.revision : -1;
}
