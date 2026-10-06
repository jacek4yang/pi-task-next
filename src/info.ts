// pi-task-next — stack identity, quotas, contracts.

export const STACK_INFO = {
  name: "pi-task-next",
  contractVersion: 1,
  /** Custom entry types persisted on the session branch (mutation log). */
  customTypes: {
    /** Task mutation records (append-only, branch-scoped replay). */
    mutation: "pinx.task.mutation",
    /** Operational checkpoints (commit markers, written last). */
    checkpoint: "pinx.task.checkpoint",
  },
  /** Versioned contracts owned by this plugin. */
  events: {
    changed: "pinx.task.changed",
  },
  /** Contracts consumed (owned elsewhere). */
  consumed: {
    jobTerminal: "pinx.runtime.job", // pi-code-runtime-next (CONTRACTS §9)
    policyDecision: "pinx.policy.decision", // pi-policy-next (CONTRACTS §8)
    githubMutation: "pinx.github.mutation", // pi-github-next (CONTRACTS §11)
  },
  tool: {
    name: "task",
    displayIdPrefix: "T",
  },
  /** Persistence/projection quotas (documented, deterministic). */
  quotas: {
    /** Maximum live (non-terminal) tasks. */
    maxOpenTasks: 64,
    /** Retained terminal (done/cancelled) tasks in the durable store. */
    maxTerminalRetained: 50,
    /** Retained checkpoints (oldest GC'd). */
    maxCheckpoints: 8,
    maxTitleLength: 200,
    maxNoteLength: 500,
    maxRefsPerTask: 16,
    maxBlockersPerTask: 16,
    maxDependenciesPerTask: 16,
    /** Bounded hot projection sizes (§12). */
    projection: {
      maxNextTodos: 3,
      maxWaitingShown: 5,
      maxBlockedShown: 5,
      maxTitleInProjection: 80,
    },
  },
} as const;
