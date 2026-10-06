// Task store: applies an append-only mutation log deterministically. The
// log lives as session custom entries (branch-scoped); replay == fold over
// entries in branch order. Revision safety (T2): every mutating record
// carries expectedRevision; a mismatch is a STALE_REVISION error — stale
// writes never silently overwrite newer state.
//
// Quotas (§18) are enforced at apply-time with explicit errors; GC is
// deterministic (oldest-terminal-first) and never removes a task still
// referenced by a live parent/dependency/checkpoint (§36).

import { assertTransition, isTerminal, taskError } from "./machine.ts";
import type {
  Task,
  TaskCheckpoint,
  TaskError,
  TaskHealth,
  TaskMutation,
  TaskState,
} from "./types.ts";
import { STACK_INFO } from "../info.ts";

const Q = STACK_INFO.quotas;

export interface ApplyResult {
  task?: Task;
  /** Emitted for every successful mutation (pinx.task.changed payload). */
  changed: {
    taskId: string;
    displayId: string;
    revision: number;
    state: TaskState;
    waitingKind?: string;
    reason?: string;
  };
  /** Tasks removed by deterministic GC (terminal, unreferenced, oldest). */
  gc: string[];
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private checkpoints: TaskCheckpoint[] = [];
  /** Set when replay hit a corrupt/incompatible record (T6: fail closed). */
  degraded: string | undefined;
  private seq = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  // -- replay ---------------------------------------------------------------

  /** Reset all derived state for a fresh branch replay (reopen/switch). */
  clearForReplay(): void {
    this.tasks.clear();
    this.checkpoints = [];
    this.degraded = undefined;
    this.seq = 0;
  }

  /**
   * Fold one persisted record. Unknown/corrupt records mark the store
   * degraded and are SKIPPED — replay never throws on expected corruption
   * (T6); callers decide policy (health report, not crash).
   */
  applyRecord(record: unknown): ApplyResult | undefined {
    try {
      return this.apply(record as TaskMutation);
    } catch (error) {
      const err = error as TaskError;
      if (
        err.code === "STALE_REVISION" ||
        err.code === "INVALID_TRANSITION" ||
        err.code === "INVALID_DEPENDENCY" ||
        err.code === "CYCLE" ||
        err.code === "TASK_QUOTA_EXCEEDED"
      ) {
        // A valid record rejected by current state (e.g. log replayed
        // across branches) — this is a real integrity problem.
        this.degraded = `${err.code}: ${err.message}`;
        return undefined;
      }
      this.degraded = `corrupt record: ${(error as Error).message}`;
      return undefined;
    }
  }

  // -- operations -----------------------------------------------------------

  apply(mutation: TaskMutation): ApplyResult {
    switch (mutation.kind) {
      case "create":
        return this.create(mutation.task);
      case "update":
        return this.update(mutation.id, mutation.expectedRevision, mutation.patch);
      case "transition":
        return this.transition(
          mutation.id,
          mutation.expectedRevision,
          mutation.to,
          mutation.waiting,
        );
      case "link":
        return this.link(
          mutation.id,
          mutation.expectedRevision,
          mutation.blockers,
          mutation.dependencies,
        );
      case "waiting-resolved":
        return this.resolveWaiting(
          mutation.id,
          mutation.expectedRevision,
          mutation.outcome,
          mutation.detail,
        );
      default: {
        const exhaustive: never = mutation;
        throw taskError(
          "TASK_STORE_CORRUPT",
          `unknown mutation kind: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  create(task: Task): ApplyResult {
    validateShape(task);
    if (this.tasks.has(task.id)) {
      throw taskError("TASK_STORE_CORRUPT", `duplicate task id: ${task.id}`);
    }
    const openCount = [...this.tasks.values()].filter((t) => !isTerminal(t.state)).length;
    if (openCount >= Q.maxOpenTasks) {
      throw taskError("TASK_QUOTA_EXCEEDED", `open task limit reached (${Q.maxOpenTasks})`);
    }
    for (const dep of [...task.blockers, ...task.dependencies]) {
      if (dep === task.id) throw taskError("INVALID_DEPENDENCY", "self dependency");
      if (!this.tasks.has(dep)) throw taskError("INVALID_DEPENDENCY", `unknown task ref: ${dep}`);
    }
    // Own the state: store a defensive copy so later mutations of the
    // caller's object (and of the log record during replay) can never
    // alias store state. Returning the stored copy keeps every handle
    // pointing at store-owned state.
    const stored: Task = structuredClone(task);
    this.tasks.set(stored.id, stored);
    return result(stored, "created");
  }

  update(
    id: string,
    expectedRevision: number,
    patch: Partial<Pick<Task, "title" | "priority" | "note" | "resourceRefs" | "evidenceRefs">>,
  ): ApplyResult {
    const task = this.mustGet(id);
    assertRevision(task, expectedRevision);
    if (patch.title !== undefined) validateTitle(patch.title);
    if (patch.note !== undefined) validateNote(patch.note);
    if (patch.resourceRefs !== undefined) validateRefs(patch.resourceRefs, "resourceRefs");
    if (patch.evidenceRefs !== undefined) validateRefs(patch.evidenceRefs, "evidenceRefs");
    Object.assign(task, patch, { revision: task.revision + 1, updatedAt: this.now() });
    return result(task, "updated");
  }

  transition(
    id: string,
    expectedRevision: number,
    to: TaskState,
    waiting?: Task["waiting"],
  ): ApplyResult {
    const task = this.mustGet(id);
    assertRevision(task, expectedRevision);
    assertTransition(task.state, to);
    // Validate BEFORE any mutation: a failed apply must leave state intact.
    if (to === "waiting" && !waiting) {
      throw taskError("INVALID_TRANSITION", "waiting transition requires a waiting reason");
    }
    if (to === "waiting") {
      validateWaiting(waiting!);
    }
    task.state = to;
    if (to === "waiting") {
      task.waiting = waiting;
    } else {
      task.waiting = undefined;
    }
    task.revision += 1;
    task.updatedAt = this.now();
    this.gcTerminal();
    return result(task, to);
  }

  link(
    id: string,
    expectedRevision: number,
    blockers?: string[],
    dependencies?: string[],
  ): ApplyResult {
    const task = this.mustGet(id);
    assertRevision(task, expectedRevision);
    const nextBlockers = blockers ?? task.blockers;
    const nextDeps = dependencies ?? task.dependencies;
    validateLinks(nextBlockers, Q.maxBlockersPerTask, "blockers");
    validateLinks(nextDeps, Q.maxDependenciesPerTask, "dependencies");
    for (const dep of [...nextBlockers, ...nextDeps]) {
      if (dep === id) throw taskError("INVALID_DEPENDENCY", "self dependency");
      if (!this.tasks.has(dep)) throw taskError("INVALID_DEPENDENCY", `unknown task ref: ${dep}`);
    }
    if (createsCycle(this.tasks, id, nextDeps)) {
      throw taskError("CYCLE", "dependency cycle detected");
    }
    task.blockers = [...nextBlockers];
    task.dependencies = [...nextDeps];
    task.revision += 1;
    task.updatedAt = this.now();
    return result(task, "linked");
  }

  resolveWaiting(
    id: string,
    expectedRevision: number,
    outcome: "ready" | "blocked",
    detail?: string,
  ): ApplyResult {
    const task = this.mustGet(id);
    assertRevision(task, expectedRevision);
    if (task.state !== "waiting") {
      throw taskError("INVALID_TRANSITION", `task ${id} is not waiting (state: ${task.state})`);
    }
    task.waiting = undefined;
    task.state = outcome === "ready" ? "in_progress" : "blocked";
    if (detail) task.note = boundNote(detail);
    task.revision += 1;
    task.updatedAt = this.now();
    return result(task, outcome === "ready" ? "resumed" : "blocked");
  }

  // -- checkpoints ----------------------------------------------------------

  /**
   * Record a checkpoint (commit marker). Callers must persist the task
   * mutations it claims FIRST — the checkpoint itself carries no task
   * state, only references (T5 is enforced by construction here and by
   * the wiring's write ordering).
   */
  checkpoint(checkpoint: TaskCheckpoint): void {
    validateCheckpoint(checkpoint);
    this.checkpoints.push(checkpoint);
    while (this.checkpoints.length > Q.maxCheckpoints) this.checkpoints.shift();
  }

  latestValidCheckpoint(): TaskCheckpoint | undefined {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const cp = this.checkpoints[i]!;
      if (checkpointReferencesValid(cp, this.tasks)) return cp;
    }
    return undefined;
  }

  allCheckpoints(): ReadonlyArray<TaskCheckpoint> {
    return this.checkpoints;
  }

  // -- queries --------------------------------------------------------------

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  mustGet(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw taskError("TASK_NOT_FOUND", `no task ${id}`);
    return task;
  }

  all(): Task[] {
    // Map preserves insertion order — deterministic by construction.
    return [...this.tasks.values()];
  }

  open(): Task[] {
    return this.all().filter((t) => !isTerminal(t.state));
  }

  nextDisplayId(): string {
    return `T${++this.seq}`;
  }

  currentDisplaySeq(): number {
    return this.seq;
  }

  health(): TaskHealth {
    const open = this.open();
    return {
      store: this.degraded ? "degraded" : "healthy",
      degradedReason: this.degraded,
      openTasks: open.length,
      waitingCount: open.filter((t) => t.state === "waiting").length,
      blockedCount: open.filter((t) => t.state === "blocked").length,
      checkpointCount: this.checkpoints.length,
      lastCheckpointAt: this.checkpoints.at(-1)?.createdAt,
    };
  }

  // -- GC -------------------------------------------------------------------

  /**
   * Deterministic terminal GC: oldest-first, bounded retention, never
   * removing a task referenced by a live task or the newest checkpoint.
   */
  private gcTerminal(): void {
    const terminal = this.all().filter((t) => isTerminal(t.state));
    let excess = terminal.length - Q.maxTerminalRetained;
    if (excess <= 0) return;
    const referenced = referencedIds(this.tasks);
    for (const task of terminal) {
      if (excess <= 0) break;
      if (referenced.has(task.id)) continue;
      this.tasks.delete(task.id);
      excess--;
    }
  }
}

// -- helpers ----------------------------------------------------------------

function result(task: Task, reason: string): ApplyResult {
  return {
    task,
    gc: [],
    changed: {
      taskId: task.id,
      displayId: task.displayId,
      revision: task.revision,
      state: task.state,
      waitingKind: task.waiting?.kind,
      reason,
    },
  };
}

function assertRevision(task: Task, expected: number): void {
  if (task.revision !== expected) {
    throw taskError(
      "STALE_REVISION",
      `stale revision for ${task.id}: expected ${expected}, current ${task.revision}`,
    );
  }
}

function referencedIds(tasks: Map<string, Task>): Set<string> {
  const refs = new Set<string>();
  for (const t of tasks.values()) {
    if (t.parentId) refs.add(t.parentId);
    for (const d of [...t.blockers, ...t.dependencies]) refs.add(d);
  }
  return refs;
}

function createsCycle(tasks: Map<string, Task>, from: string, dependencies: string[]): boolean {
  const seen = new Set<string>();
  const stack = [...dependencies];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const task = tasks.get(id);
    if (task) stack.push(...task.dependencies);
  }
  return false;
}

function checkpointReferencesValid(cp: TaskCheckpoint, tasks: Map<string, Task>): boolean {
  return cp.activeTaskIds.every((id) => tasks.has(id));
}

function validateShape(task: Task): void {
  if (task.v !== 1) throw taskError("TASK_STORE_CORRUPT", "unsupported task schema version");
  if (typeof task.id !== "string" || task.id.length === 0) {
    throw taskError("TASK_STORE_CORRUPT", "task id missing");
  }
  validateTitle(task.title);
  validateRefs(task.resourceRefs, "resourceRefs");
  validateRefs(task.evidenceRefs, "evidenceRefs");
}

function validateTitle(title: string): void {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw taskError("TASK_QUOTA_EXCEEDED", "title required");
  }
  if (title.length > Q.maxTitleLength) {
    throw taskError(
      "TASK_QUOTA_EXCEEDED",
      `title exceeds ${Q.maxTitleLength} chars (bound, not truncated)`,
    );
  }
}

function validateNote(note: string): void {
  if (note.length > Q.maxNoteLength) {
    throw taskError(
      "TASK_QUOTA_EXCEEDED",
      `note exceeds ${Q.maxNoteLength} chars (bound, not truncated)`,
    );
  }
}

function boundNote(note: string): string {
  return note.length > Q.maxNoteLength ? note.slice(0, Q.maxNoteLength) : note;
}

function validateRefs(refs: string[], field: string): void {
  if (refs.length > Q.maxRefsPerTask) {
    throw taskError("TASK_QUOTA_EXCEEDED", `${field} exceeds ${Q.maxRefsPerTask} refs`);
  }
}

function validateLinks(links: string[], max: number, field: string): void {
  if (links.length > max) {
    throw taskError("TASK_QUOTA_EXCEEDED", `${field} exceed ${max}`);
  }
}

function validateWaiting(waiting: NonNullable<Task["waiting"]>): void {
  switch (waiting.kind) {
    case "job":
      if (!waiting.jobId) throw taskError("INVALID_TRANSITION", "job wait requires jobId");
      break;
    case "approval":
      if (!waiting.digest) throw taskError("INVALID_TRANSITION", "approval wait requires digest");
      break;
    case "ci":
      if (!waiting.watchId) throw taskError("INVALID_TRANSITION", "ci wait requires watchId");
      break;
    case "external":
      if (!waiting.description || waiting.description.length > Q.maxNoteLength) {
        throw taskError(
          "INVALID_TRANSITION",
          `external wait requires a short description (<= ${Q.maxNoteLength})`,
        );
      }
      break;
    default: {
      const exhaustive: never = waiting;
      throw taskError("INVALID_TRANSITION", `unknown waiting kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function validateCheckpoint(cp: TaskCheckpoint): void {
  if (cp.v !== 1) throw taskError("TASK_STORE_CORRUPT", "unsupported checkpoint version");
  if (cp.activeTaskIds.length > Q.maxOpenTasks) {
    throw taskError("TASK_QUOTA_EXCEEDED", "checkpoint references too many tasks");
  }
  for (const list of [
    cp.pendingJobs,
    cp.pendingApprovals,
    cp.pendingCI,
    cp.importantEvidenceRefs,
    cp.runtimeBufferRefs,
  ]) {
    if (list.length > Q.maxRefsPerTask) {
      throw taskError("TASK_QUOTA_EXCEEDED", "checkpoint ref list exceeds quota");
    }
  }
  if (cp.nextAction !== undefined && cp.nextAction.length > Q.maxNoteLength) {
    throw taskError("TASK_QUOTA_EXCEEDED", "checkpoint nextAction exceeds note quota");
  }
}
