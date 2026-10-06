// Bounded deterministic active-task projection (§11-13, §27).
//
// Model-visible rules:
//   - active/in_progress always visible; waiting/blocked visible; next
//     todos bounded (maxNextTodos); terminal tasks NEVER in hot projection;
//   - ordering: active, blocked, waiting, then priority-ordered next todos
//     (critical > high > normal > low, then creation order);
//   - NO timestamps, no volatile counters, no opaque internal ids — short
//     display ids + titles + state + waiting reason only;
//   - byte-identical output when task state is unchanged (T7);
//   - an empty task list produces an EMPTY STRING (no empty task block).

import { STACK_INFO } from "../info.ts";
import type { Task } from "./types.ts";

const PRIORITY_RANK: Record<Task["priority"], number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const Q = STACK_INFO.quotas.projection;

function boundTitle(title: string): string {
  return title.length > Q.maxTitleInProjection
    ? title.slice(0, Q.maxTitleInProjection - 1) + "…"
    : title;
}

function waitingText(task: Task): string {
  switch (task.waiting?.kind) {
    case "job":
      return `waiting on job ${task.waiting.jobId}`;
    case "approval":
      return "waiting on approval";
    case "ci":
      return `waiting on CI (${task.waiting.watchId})`;
    case "external":
      return `waiting: ${task.waiting.description}`;
    default:
      return "";
  }
}

/** Sorted view per §12 ordering. Terminal tasks excluded. */
export function projectionTasks(tasks: Task[]): Task[] {
  const open = tasks.filter((t) => t.state !== "done" && t.state !== "cancelled");
  const byState = (state: Task["state"]) => open.filter((t) => t.state === state);
  const active = byState("in_progress");
  const blocked = byState("blocked").slice(0, Q.maxBlockedShown);
  const waiting = byState("waiting").slice(0, Q.maxWaitingShown);
  const next = byState("todo")
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    .slice(0, Q.maxNextTodos);
  return [...active, ...blocked, ...waiting, ...next];
}

/** The complete hot projection block ("" when nothing to show). */
export function renderProjection(tasks: Task[]): string {
  const visible = projectionTasks(tasks);
  if (visible.length === 0) return "";
  const lines: string[] = ["[tasks]"];
  for (const task of visible) {
    const waiting = waitingText(task);
    const note = task.note ? ` — ${task.note}` : "";
    const waitingSuffix = waiting ? ` (${waiting})` : "";
    lines.push(
      `${task.displayId} [${task.priority}] ${task.state}: ${boundTitle(task.title)}${waitingSuffix}${note}`,
    );
  }
  return lines.join("\n");
}

/** Exact model-visible byte cost of the projection (UTF-8). */
export function projectionBytes(tasks: Task[]): number {
  return Buffer.byteLength(renderProjection(tasks), "utf8");
}
