// Explicit task state machine (§7). Transitions are enumerated; anything
// not listed fails with INVALID_TRANSITION. No implicit multi-hop moves.

import type { TaskError, TaskState } from "./types.ts";

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  todo: ["in_progress", "waiting", "blocked", "cancelled"],
  in_progress: ["waiting", "blocked", "done", "cancelled"],
  waiting: ["in_progress", "blocked", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw taskError(
      "INVALID_TRANSITION",
      `invalid transition ${from} -> ${to} (allowed: ${TRANSITIONS[from].join(", ") || "none"})`,
    );
  }
}

/** Terminal states: no outgoing transitions, excluded from hot projection. */
export function isTerminal(state: TaskState): boolean {
  return state === "done" || state === "cancelled";
}

export function taskError(code: TaskError["code"], message: string): TaskError {
  const error = new Error(message) as TaskError;
  error.code = code;
  return error;
}
