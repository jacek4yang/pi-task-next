// pi-task-next — durable long-horizon task state for Pi.
//
// Persistence: append-only custom entries on the session branch (uniform
// log for tool- AND event-originated mutations); branch-scoped replay on
// session_start/session_tree — sibling branches cannot contaminate state.
// Checkpoints are written LAST (commit markers over already-durable state).
//
// Model visibility: the bounded projection is injected TRANSIENTLY via the
// `context` event before each LLM call — deterministic bytes (byte-identical
// when task state is unchanged), zero transcript growth, empty sessions
// inject nothing. No timestamps, counters, or opaque ids in hot projection.
//
// Waiting (T3): tasks wait on jobs via the versioned `pinx.runtime.job`
// contract and on approvals via `pinx.policy.decision` — event-driven, no
// model polling anywhere.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cwd as processCwd } from "node:process";
import { renderProjection } from "./core/projection.ts";
import { TaskStore } from "./core/store.ts";
import { IssueStore, issueStorePath } from "./core/issues.ts";
import { taskError } from "./core/machine.ts";
import { STACK_INFO } from "./info.ts";
import {
  ISSUE_TOOL_DESCRIPTION,
  ISSUE_TOOL_NAME,
  TASK_TOOL_DESCRIPTION,
  TASK_TOOL_NAME,
  issueToolParameters,
  taskToolParameters,
} from "./tool-schema.ts";
import type { Task, TaskCheckpoint, TaskError, TaskMutation, TaskPriority } from "./core/types.ts";

type TaskErrorCode = TaskError["code"];

function respond(text: string, isError = false, details?: unknown) {
  return { content: [{ type: "text" as const, text }], isError, details };
}

function errorResponse(error: unknown) {
  const err = error as { code?: TaskErrorCode; message: string };
  const known = err.code !== undefined;
  const text = known ? `${err.code}: ${err.message}` : `TASK_STORE_CORRUPT: ${err.message}`;
  return respond(text, true, { code: err.code ?? "TASK_STORE_CORRUPT" });
}

export default function piTaskNext(pi: ExtensionAPI) {
  const store = new TaskStore();
  const issues = new IssueStore(issueStorePath(getAgentDir(), processCwd()));
  let sessionId = "";
  let dirtySinceCheckpoint = false;
  /** Pending job/approval refs observed for checkpointing. */
  const pendingJobs = new Set<string>();
  const pendingApprovals = new Set<string>();

  function displayToId(display: string): string {
    const task = store.all().find((t) => t.displayId === display);
    if (!task) throw taskError("TASK_NOT_FOUND", `no task with display id ${display}`);
    return task.id;
  }

  function emitChanged(task: Task, reason: string): void {
    try {
      pi.events.emit(STACK_INFO.events.changed, {
        v: 1,
        taskId: task.id,
        displayId: task.displayId,
        revision: task.revision,
        state: task.state,
        waitingKind: task.waiting?.kind,
        reason,
      });
    } catch {
      // observability is best-effort
    }
  }

  /** Persist one mutation to the branch log, then apply it (write-ahead). */
  function commit(mutation: TaskMutation): ReturnType<TaskStore["apply"]> {
    const result = store.apply(mutation);
    // apply() succeeded — the mutation record is the durable truth on the
    // branch; append AFTER a successful in-memory apply so a failed apply
    // never leaves a poison record.
    pi.appendEntry(STACK_INFO.customTypes.mutation, { v: 1, mutation });
    dirtySinceCheckpoint = true;
    if (result.task) emitChanged(result.task, result.changed.reason ?? "");
    return result;
  }

  function autoCheckpoint(): void {
    if (!dirtySinceCheckpoint || !sessionId) return;
    const open = store.open();
    for (const task of open) {
      if (task.waiting?.kind === "job") pendingJobs.add(task.waiting.jobId);
      if (task.waiting?.kind === "approval") pendingApprovals.add(task.waiting.digest);
    }
    const checkpoint: TaskCheckpoint = {
      v: 1,
      sessionId,
      activeTaskIds: open.map((t) => t.id),
      runtimeBufferRefs: [],
      pendingJobs: [...pendingJobs].slice(0, STACK_INFO.quotas.maxRefsPerTask),
      pendingApprovals: [...pendingApprovals].slice(0, STACK_INFO.quotas.maxRefsPerTask),
      pendingCI: [],
      importantEvidenceRefs: [],
      createdAt: Date.now(),
    };
    try {
      store.checkpoint(checkpoint);
      pi.appendEntry(STACK_INFO.customTypes.checkpoint, { v: 1, checkpoint });
      dirtySinceCheckpoint = false;
    } catch {
      // checkpointing is best-effort continuity, never a turn breaker
    }
  }

  function replayBranch(
    branch: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
  ): number {
    store.clearForReplay();
    let applied = 0;
    for (const entry of branch) {
      if (entry.type !== "custom") continue;
      const data = entry.data as
        { v?: number; mutation?: TaskMutation; checkpoint?: TaskCheckpoint } | undefined;
      if (entry.customType === STACK_INFO.customTypes.mutation && data?.mutation) {
        if (store.applyRecord(data.mutation)) applied++;
      } else if (entry.customType === STACK_INFO.customTypes.checkpoint && data?.checkpoint) {
        try {
          store.checkpoint(data.checkpoint);
        } catch {
          store.degraded = "corrupt checkpoint entry skipped";
        }
      }
    }
    return applied;
  }

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId() ?? "";
    replayBranch(ctx.sessionManager.getBranch() as never);
    void issues.load();
    const cp = store.latestValidCheckpoint();
    if (store.degraded) {
      try {
        ctx.ui.notify(`pi-task-next: degraded store — ${store.degraded}`, "warning");
      } catch {
        // no UI available; health remains queryable via /task-next
      }
    }
    void cp;
  });

  pi.on("session_tree", (_event, ctx) => {
    // Branch switches re-derive state from the new active branch.
    replayBranch(ctx.sessionManager.getBranch() as never);
  });

  pi.on("turn_end", () => {
    autoCheckpoint();
  });

  // -- event-driven waiting (T3: no model polling) --------------------------

  pi.events.on("pinx.runtime.job", (payload) => {
    const event = payload as {
      v?: number;
      jobId?: string;
      state?: string;
      exitCode?: number | null;
    };
    if (event?.v !== 1 || !event.jobId || !event.state) return;
    for (const task of store.open()) {
      if (
        task.state !== "waiting" ||
        task.waiting?.kind !== "job" ||
        task.waiting.jobId !== event.jobId
      ) {
        continue;
      }
      const outcome = event.state === "completed" ? "ready" : "blocked";
      const detail =
        event.state === "completed"
          ? `job ${event.jobId} completed`
          : `job ${event.jobId} ${event.state}${event.exitCode != null ? ` (exit ${event.exitCode})` : ""}`;
      try {
        commit({
          kind: "waiting-resolved",
          id: task.id,
          expectedRevision: task.revision,
          outcome,
          detail,
        });
        pendingJobs.delete(event.jobId);
      } catch {
        // stale revision during a concurrent tool call: the next turn's
        // projection still reflects reality; the job event is not lost
        // because the task's waiting record remains until resolved.
      }
    }
  });

  pi.events.on("pinx.policy.decision", (payload) => {
    const event = payload as { v?: number; digest?: string; decision?: string };
    if (event?.v !== 1 || !event.digest || !event.decision) return;
    if (event.decision !== "allow" && event.decision !== "deny") return;
    for (const task of store.open()) {
      if (
        task.state !== "waiting" ||
        task.waiting?.kind !== "approval" ||
        task.waiting.digest !== event.digest
      ) {
        continue;
      }
      // Only an approval FOR THIS EXACT digest resolves the wait (P2/T3);
      // a materially different action produces a different digest and the
      // task keeps waiting — no silent resume under stale approval.
      const outcome = event.decision === "allow" ? "ready" : "blocked";
      try {
        commit({
          kind: "waiting-resolved",
          id: task.id,
          expectedRevision: task.revision,
          outcome,
          detail: event.decision === "allow" ? "approval granted" : "approval denied",
        });
        pendingApprovals.delete(event.digest);
      } catch {
        // concurrent tool call raced us; waiting record persists
      }
    }
  });

  // -- the task tool --------------------------------------------------------

  pi.registerTool({
    name: TASK_TOOL_NAME,
    label: "Task",
    description: TASK_TOOL_DESCRIPTION,
    parameters: taskToolParameters(),
    async execute(_toolCallId: unknown, params: unknown) {
      try {
        return handleTaskAction(params as never);
      } catch (error) {
        return errorResponse(error);
      }
    },
  } as never);

  type TaskParams = {
    action: string;
    task?: string;
    title?: string;
    priority?: TaskPriority;
    parent?: string;
    note?: string;
    kind?: "job" | "approval" | "ci" | "external";
    ref?: string;
    repository?: string;
    branch?: string;
    headSha?: string;
    nextAction?: string;
  };

  function handleTaskAction(p: TaskParams) {
    switch (p.action) {
      case "create": {
        if (!p.title) return respond("INVALID_TRANSITION: create requires a title", true);
        const id = `task_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
        const parent = p.parent ? displayToId(p.parent) : undefined;
        const task: Task = {
          v: 1,
          id,
          displayId: store.nextDisplayId(),
          title: p.title,
          state: "todo",
          priority: p.priority ?? "normal",
          parentId: parent,
          blockers: [],
          dependencies: [],
          resourceRefs: [],
          evidenceRefs: [],
          note: p.note,
          revision: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const result = commit({ kind: "create", task });
        const t = result.task!;
        return respond(
          `${t.displayId} [${t.priority}] ${t.state}: ${t.title} (rev ${t.revision})`,
          false,
          {
            taskId: t.id,
            displayId: t.displayId,
            revision: t.revision,
          },
        );
      }
      case "list": {
        const rows = store
          .all()
          .map(
            (t) =>
              `${t.displayId} [${t.priority}] ${t.state}${t.waiting ? ` (waiting: ${t.waiting.kind})` : ""}: ${t.title}`,
          );
        const body = rows.length > 0 ? rows.join("\n") : "(no tasks)";
        const truncated =
          rows.length > 40
            ? `\n… ${rows.length - 40} older tasks omitted (use get for detail)`
            : "";
        return respond(body + truncated, false, { open: store.open().length, total: rows.length });
      }
      case "get": {
        const t = store.mustGet(p.task ? displayToId(p.task) : mustTask(p));
        return respond(
          [
            `${t.displayId} [${t.priority}] ${t.state} (rev ${t.revision})`,
            `title: ${t.title}`,
            t.parentId ? `parent: ${store.get(t.parentId)?.displayId ?? t.parentId}` : undefined,
            t.blockers.length > 0
              ? `blockers: ${t.blockers.map((b) => store.get(b)?.displayId ?? b).join(", ")}`
              : undefined,
            t.dependencies.length > 0
              ? `dependencies: ${t.dependencies.map((d) => store.get(d)?.displayId ?? d).join(", ")}`
              : undefined,
            t.waiting ? `waiting: ${t.waiting.kind}` : undefined,
            t.note ? `note: ${t.note}` : undefined,
            t.resourceRefs.length > 0 ? `resources: ${t.resourceRefs.join(", ")}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          false,
          { taskId: t.id, revision: t.revision },
        );
      }
      case "start":
      case "complete":
      case "cancel": {
        const id = displayToId(mustTask(p));
        const task = store.mustGet(id);
        const to =
          p.action === "start" ? "in_progress" : p.action === "complete" ? "done" : "cancelled";
        const result = commit({ kind: "transition", id, expectedRevision: task.revision, to });
        const t = result.task!;
        return respond(`${t.displayId} → ${t.state} (rev ${t.revision})`, false, {
          revision: t.revision,
        });
      }
      case "update": {
        const id = displayToId(mustTask(p));
        const task = store.mustGet(id);
        const result = commit({
          kind: "update",
          id,
          expectedRevision: task.revision,
          patch: {
            title: p.title,
            priority: p.priority,
            note: p.note,
          },
        });
        const t = result.task!;
        return respond(`${t.displayId} updated (rev ${t.revision})`, false, {
          revision: t.revision,
        });
      }
      case "wait": {
        if (!p.kind || !p.ref)
          return respond("INVALID_TRANSITION: wait requires kind and ref", true);
        const id = displayToId(mustTask(p));
        const task = store.mustGet(id);
        const waiting = {
          kind: p.kind,
          ...(p.kind === "job" ? { jobId: p.ref } : {}),
          ...(p.kind === "approval" ? { digest: p.ref } : {}),
          ...(p.kind === "ci" ? { watchId: p.ref } : {}),
          ...(p.kind === "external" ? { description: p.ref } : {}),
        } as Task["waiting"];
        const result = commit({
          kind: "transition",
          id,
          expectedRevision: task.revision,
          to: "waiting",
          waiting,
        });
        const t = result.task!;
        return respond(
          `${t.displayId} waiting on ${p.kind} (rev ${t.revision}) — resumes automatically`,
          false,
          {
            revision: t.revision,
          },
        );
      }
      case "resume":
      case "block": {
        const id = displayToId(mustTask(p));
        const task = store.mustGet(id);
        const to = p.action === "resume" ? "in_progress" : "blocked";
        const result = commit({ kind: "transition", id, expectedRevision: task.revision, to });
        const t = result.task!;
        return respond(`${t.displayId} → ${t.state} (rev ${t.revision})`, false, {
          revision: t.revision,
        });
      }
      case "checkpoint": {
        if (!sessionId) return respond("TASK_STORE_CORRUPT: no session", true);
        const open = store.open();
        const checkpoint: TaskCheckpoint = {
          v: 1,
          sessionId,
          activeTaskIds: open.map((t) => t.id),
          currentRepository: p.repository,
          currentBranch: p.branch,
          headSha: p.headSha,
          lastCommittedAction: p.note,
          runtimeBufferRefs: [],
          pendingJobs: [...pendingJobs].slice(0, STACK_INFO.quotas.maxRefsPerTask),
          pendingApprovals: [...pendingApprovals].slice(0, STACK_INFO.quotas.maxRefsPerTask),
          pendingCI: [],
          importantEvidenceRefs: [],
          nextAction: p.nextAction,
          createdAt: Date.now(),
        };
        store.checkpoint(checkpoint);
        pi.appendEntry(STACK_INFO.customTypes.checkpoint, { v: 1, checkpoint });
        dirtySinceCheckpoint = false;
        return respond(
          `checkpoint committed (${open.length} active task(s), ${checkpoint.pendingJobs.length} pending job(s))`,
          false,
        );
      }
      default:
        return respond(`INVALID_TRANSITION: unknown action ${p.action}`, true);
    }
  }

  function mustTask(p: TaskParams): string {
    if (!p.task) throw taskError("TASK_NOT_FOUND", "task display id required for this action");
    return p.task;
  }

  // -- issue candidates ------------------------------------------------------

  pi.registerTool({
    name: ISSUE_TOOL_NAME,
    label: "Issue candidate",
    description: ISSUE_TOOL_DESCRIPTION,
    parameters: issueToolParameters(),
    async execute(_toolCallId: unknown, params: unknown) {
      const p = params as { action: string; title?: string; description?: string; id?: string };
      try {
        if (p.action === "add") {
          if (!p.title || !p.description)
            return respond("INVALID_TRANSITION: add requires title and description", true);
          const issue = await issues.add({ title: p.title, description: p.description });
          return respond(`issue candidate recorded: ${issue.id} — ${issue.title}`, false);
        }
        if (p.action === "list") {
          const rows = issues
            .list()
            .map((i) => `${i.state === "open" ? "○" : "•"} ${i.id} ${i.title}`);
          return respond(rows.length > 0 ? rows.join("\n") : "(no issue candidates)", false);
        }
        if (p.action === "dismiss") {
          if (!p.id) return respond("TASK_NOT_FOUND: dismiss requires id", true);
          await issues.dismiss(p.id);
          return respond(`dismissed ${p.id}`, false);
        }
        return respond("INVALID_TRANSITION: unknown issue action", true);
      } catch (error) {
        return errorResponse(error);
      }
    },
  } as never);

  // -- transient deterministic projection (T7, §13) --------------------------

  pi.on("context", (event) => {
    const block = renderProjection(store.all());
    if (!block) return undefined;
    return {
      messages: [...event.messages, { role: "user" as const, content: block, timestamp: 0 }],
    };
  });

  // -- status command (UI-only; health never enters model context) -----------

  // Issue-candidate promotion boundary (CONTRACTS §11): pi-github-next
  // emits pinx.github.mutation for a completed create_issue carrying the
  // local candidate id; we mark OUR candidate promoted. Task state owns
  // the candidate; GitHub owns the external resource — refs only.
  pi.events.on(STACK_INFO.consumed.githubMutation, (payload) => {
    const event = payload as {
      v?: number;
      operation?: string;
      state?: string;
      issueCandidateId?: string;
      resultRef?: string;
    };
    if (event?.v !== 1 || event.operation !== "create_issue" || event.state !== "completed") return;
    if (typeof event.issueCandidateId !== "string") return;
    void issues.markPromoted(event.issueCandidateId).catch(() => {
      // unknown candidate id: promotion race — ignore, journal is truth
    });
  });

  pi.registerCommand("task-next", {
    description: "Show pi-task-next health and active tasks",
    handler: async (_args, ctx) => {
      const health = store.health();
      const lines = [
        `pi-task-next ${STACK_INFO.contractVersion} · store ${health.store}${health.degradedReason ? ` (${health.degradedReason})` : ""}`,
        `open ${health.openTasks} · waiting ${health.waitingCount} · blocked ${health.blockedCount} · checkpoints ${health.checkpointCount}`,
        `issues: ${issues.open().length} open candidate(s)${issues.degraded ? ` · ${issues.degraded}` : ""}`,
      ];
      const projection = renderProjection(store.all());
      if (projection) lines.push(projection);
      await ctx.ui.notify(lines.join("\n"), health.store === "healthy" ? "info" : "warning");
    },
  });
}
