// Pure task core types. No Pi imports — deterministic, independently
// testable. Operational facts only; never reasoning narratives (§48).

export type TaskState = "todo" | "in_progress" | "waiting" | "blocked" | "done" | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "critical";

/** Typed, bounded waiting reason. */
export type WaitingReason =
  | { kind: "job"; jobId: string }
  | { kind: "approval"; digest: string }
  | { kind: "ci"; watchId: string } // reserved contract; pi-ci-next owns CI truth
  | { kind: "external"; description: string }; // bounded short reference

export interface Task {
  v: 1;
  /** Durable internal id (stable). */
  id: string;
  /** Short display id (T1, T2, …) used in model-visible projection. */
  displayId: string;
  title: string;
  state: TaskState;
  priority: TaskPriority;
  parentId?: string;
  blockers: string[]; // task ids that must resolve first
  dependencies: string[]; // task ids whose completion is awaited
  waiting?: WaitingReason;
  resourceRefs: string[]; // bounded refs (buffer names, evidence ids, paths)
  evidenceRefs: string[];
  note?: string; // operational fact, bounded
  /** Monotonic per-task revision; every mutation increments it. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** One durable mutation record (the append-only log entry payload). */
export type TaskMutation =
  | { kind: "create"; task: Task }
  | {
      kind: "update";
      id: string;
      expectedRevision: number;
      patch: Partial<Pick<Task, "title" | "priority" | "note" | "resourceRefs" | "evidenceRefs">>;
    }
  | {
      kind: "transition";
      id: string;
      expectedRevision: number;
      to: TaskState;
      waiting?: WaitingReason;
    }
  | {
      kind: "link";
      id: string;
      expectedRevision: number;
      blockers?: string[];
      dependencies?: string[];
    }
  | {
      kind: "waiting-resolved";
      id: string;
      expectedRevision: number;
      outcome: "ready" | "blocked";
      detail?: string;
    };

export interface TaskError extends Error {
  code:
    | "TASK_NOT_FOUND"
    | "STALE_REVISION"
    | "INVALID_TRANSITION"
    | "TASK_STORE_CORRUPT"
    | "TASK_QUOTA_EXCEEDED"
    | "INVALID_DEPENDENCY"
    | "CYCLE";
}

/**
 * Operational checkpoint — resumable FACTS with references, not reasoning.
 * Written LAST (commit marker) after the state it claims is durable (T5).
 */
export interface TaskCheckpoint {
  v: 1;
  sessionId: string;
  activeTaskIds: string[];
  currentRepository?: string;
  currentBranch?: string;
  headSha?: string;
  lastCommittedAction?: string;
  runtimeBufferRefs: string[];
  pendingJobs: string[]; // jobIds
  pendingApprovals: string[]; // approval digests
  pendingCI: string[]; // reserved watch ids (schema only; no CI yet)
  importantEvidenceRefs: string[];
  nextAction?: string;
  createdAt: number;
}

export interface IssueCandidate {
  v: 1;
  id: string;
  title: string;
  description: string; // short, bounded
  sourceRefs: string[];
  state: "open" | "dismissed" | "promoted";
  createdAt: number;
  updatedAt: number;
}

/** Health snapshot (structured; never injected into model context). */
export interface TaskHealth {
  store: "healthy" | "degraded";
  degradedReason?: string;
  openTasks: number;
  waitingCount: number;
  blockedCount: number;
  checkpointCount: number;
  lastCheckpointAt?: number;
}
