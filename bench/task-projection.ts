// Task cacheability benchmark (§38): scenarios A-F over the pure core,
// byte-accurate projection measurement, tool-schema footprint, and reopen
// restore cost. Deterministic; no live model, no LLM anywhere.
//
// Run: npx tsx bench/task-projection.ts → JSON on stdout

import { TaskStore } from "../src/core/store.ts";
import { renderProjection, projectionBytes } from "../src/core/projection.ts";
import {
  TASK_TOOL_DESCRIPTION,
  TASK_TOOL_NAME,
  ISSUE_TOOL_DESCRIPTION,
  ISSUE_TOOL_NAME,
  taskToolParameters,
  issueToolParameters,
  toolSchemaBytes,
} from "../src/tool-schema.ts";
import type { Task, TaskMutation } from "../src/core/types.ts";

let clock = 1_700_000_000_000;
const now = () => ++clock;

function newStore(): TaskStore {
  return new TaskStore(now);
}

function make(
  store: TaskStore,
  title: string,
  priority: Task["priority"] = "normal",
): { id: string; displayId: string; mutation: TaskMutation } {
  const task: Task = {
    v: 1,
    id: `task_${clock++}_${Math.floor(Math.random() * 1e9).toString(36)}`,
    displayId: store.nextDisplayId(),
    title,
    state: "todo",
    priority,
    blockers: [],
    dependencies: [],
    resourceRefs: [],
    evidenceRefs: [],
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  const mutation: TaskMutation = { kind: "create", task };
  store.apply(structuredClone(mutation));
  return { id: task.id, displayId: task.displayId, mutation };
}

function firstCommonPrefixDiff(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const min = Math.min(ba.length, bb.length);
  let i = 0;
  while (i < min && ba[i] === bb[i]) i++;
  return i;
}

// A. no task — zero prompt overhead
const noTaskBytes = projectionBytes(newStore().all());

// B. stable active task across 5 "turns" — byte-identical projection
const stable = newStore();
const stableTask = make(stable, "Implement policy integration", "high");
stable.apply({ kind: "transition", id: stableTask.id, expectedRevision: 1, to: "in_progress" });
const stableProjections = Array.from({ length: 5 }, () => renderProjection(stable.all()));
const stableBytes = projectionBytes(stable.all());
const stableIdentical = stableProjections.every((p) => p === stableProjections[0]);

// C. one task state change — projection changes only in the task tail
const beforeChange = renderProjection(stable.all());
stable.apply({
  kind: "update",
  id: stableTask.id,
  expectedRevision: 2,
  patch: { note: "waiting on windows CI result" },
});
const afterChange = renderProjection(stable.all());
const changeFirstDiff = firstCommonPrefixDiff(beforeChange, afterChange);

// D. completed task leaves hot projection
const done = newStore();
const doneTask = make(done, "Write reopen test");
done.apply({ kind: "transition", id: doneTask.id, expectedRevision: 1, to: "in_progress" });
const beforeDone = projectionBytes(done.all());
done.apply({ kind: "transition", id: doneTask.id, expectedRevision: 2, to: "done" });
const afterDone = projectionBytes(done.all());

// E. waiting task is visible with its typed reason
const waiting = newStore();
const waitingTask = make(waiting, "Ship after build");
waiting.apply({ kind: "transition", id: waitingTask.id, expectedRevision: 1, to: "in_progress" });
waiting.apply({
  kind: "transition",
  id: waitingTask.id,
  expectedRevision: 2,
  to: "waiting",
  waiting: { kind: "job", jobId: "job_0042" },
});
const waitingProjection = renderProjection(waiting.all());
const waitingBytes = projectionBytes(waiting.all());

// F. reopen restores the same deterministic projection (log replay)
const log: TaskMutation[] = [
  structuredClone(waitingTask.mutation),
  { kind: "transition", id: waitingTask.id, expectedRevision: 1, to: "in_progress" },
  {
    kind: "transition",
    id: waitingTask.id,
    expectedRevision: 2,
    to: "waiting",
    waiting: { kind: "job", jobId: "job_0042" },
  },
];
const reopened = newStore();
for (const m of log) reopened.applyRecord(structuredClone(m));
const reopenProjection = renderProjection(reopened.all());
const reopenMatches = reopenProjection === waitingProjection;
const reopenStart = process.hrtime.bigint();
for (let i = 0; i < 1000; i++) {
  const s = newStore();
  for (const m of log) s.applyRecord(structuredClone(m));
  renderProjection(s.all());
}
const reopenRestoreUs = (Number(process.hrtime.bigint() - reopenStart) / 1e6 / 1000) * 1000;

// tool-schema footprint
const taskSchema = toolSchemaBytes(taskToolParameters(), TASK_TOOL_DESCRIPTION);
const issueSchema = toolSchemaBytes(issueToolParameters(), ISSUE_TOOL_DESCRIPTION);

process.stdout.write(
  JSON.stringify(
    {
      bench: "pi-task-next cacheability scenarios",
      scenarios: {
        A_noTask: { modelVisibleTaskBytes: noTaskBytes },
        B_stableActiveTask: {
          modelVisibleTaskBytes: stableBytes,
          byteIdenticalAcrossTurns: stableIdentical,
          projection: stableProjections[0],
        },
        C_stateChange: {
          firstChangedByte: changeFirstDiff,
          note: "only the task block changes; it lives at the injected tail",
        },
        D_completedLeavesHotContext: { beforeBytes: beforeDone, afterBytes: afterDone },
        E_waitingTask: { modelVisibleTaskBytes: waitingBytes, projection: waitingProjection },
        F_reopen: {
          restoreMatches: reopenMatches,
          restoreUsPerReopen: Number(reopenRestoreUs.toFixed(1)),
        },
      },
      toolSchema: {
        [TASK_TOOL_NAME]: taskSchema,
        [ISSUE_TOOL_NAME]: issueSchema,
        totalBytes: taskSchema.totalBytes + issueSchema.totalBytes,
        defaultActive: true,
        note: "long-horizon layer needs turn-0 discoverability; measured cost recorded",
      },
    },
    null,
    2,
  ) + "\n",
);
