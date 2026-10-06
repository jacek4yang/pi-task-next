// Pi integration gate tests ([T1] reopen continuity, [T3] event-driven
// waiting, [T7] projection stability, checkpoint ordering). Drives the REAL
// extension wiring through a mock registration adapter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { default as piTaskNext } from "../src/index.ts";
import type { TaskCheckpoint } from "../src/core/types.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface Entry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
}

function harness() {
  const handlers = new Map<string, Handler[]>();
  const bus: Array<{ channel: string; payload: unknown }> = [];
  const busHandlers = new Map<string, Array<(payload: unknown) => void>>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const registeredTools: Array<{ name?: string }> = [];
  const agentDir = mkdtempSync(join(tmpdir(), "pinx-task-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const branchFixture: Entry[] = [];

  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool: (tool: { name?: string }) => {
      registeredTools.push(tool);
    },
    registerCommand: (name: string) => {
      void name;
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
      branchFixture.push({ type: "custom", id: `c${appended.length}`, customType, data });
    },
    events: {
      emit: (channel: string, payload: unknown) => {
        bus.push({ channel, payload });
      },
      on: (channel: string, handler: (payload: unknown) => void) => {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => {};
      },
    },
  };

  const ctx = {
    sessionManager: {
      getSessionId: () => "sess-task-1",
      getLeafId: () => "leaf-1",
      getBranch: () => branchFixture,
    },
    ui: {
      notify: async (message: string) => {
        notifications.push(message);
      },
    },
  };

  piTaskNext(pi as never);

  const dispatch = async (event: string, payload: unknown) => {
    const results: unknown[] = [];
    for (const h of handlers.get(event) ?? []) {
      results.push(await h(payload, ctx));
    }
    return results[0];
  };

  const emitBus = (channel: string, payload: unknown) => {
    for (const h of busHandlers.get(channel) ?? []) h(payload);
  };

  const toolCall = async (params?: Record<string, unknown>) => {
    void params;
    return undefined;
  };

  const cleanup = () => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(agentDir, { recursive: true, force: true });
  };

  return {
    pi,
    dispatch,
    emitBus,
    bus,
    appended,
    notifications,
    registeredTools,
    branchFixture,
    cleanup,
    toolCall,
  };
}

/** Extract the registered task tool definition (execute fn) from the mock. */
function taskTool(h: ReturnType<typeof harness>): {
  name: string;
  execute: (id: unknown, params: unknown) => Promise<unknown>;
} {
  const def = h.registeredTools.find((t) => t.name === "task") as never as {
    name: string;
    execute: (id: unknown, params: unknown) => Promise<unknown>;
  };
  assert.ok(def, "task tool registered");
  return def;
}

async function createTask(h: ReturnType<typeof harness>, title: string) {
  const tool = taskTool(h);
  const result = (await tool.execute(undefined, { action: "create", title })) as {
    content: Array<{ text: string }>;
  };
  const match = /(T\d+)/.exec(result.content[0]!.text);
  assert.ok(match, `display id in response: ${result.content[0]!.text}`);
  return match[1]!;
}

test("[T1] task state survives session reopen via branch replay (no transcript reread)", async () => {
  const h = harness();
  const display = await createTask(h, "Implement reopen continuity");
  const tool = taskTool(h);
  await tool.execute(undefined, { action: "start", task: display });
  await h.dispatch("turn_end", {});
  const logSize = h.appended.length;
  assert.ok(logSize >= 2, "mutations persisted to the branch log");

  // Simulate reopen: same branch, new extension instance.
  const branch = h.branchFixture;
  const h2 = harness();
  // Rebind the SAME branch fixture into the new harness by copying entries.
  for (const entry of branch) h2.branchFixture.push(structuredClone(entry));
  await h2.dispatch("session_start", { reason: "startup" });
  const tool2 = taskTool(h2);
  const got = (await tool2.execute(undefined, { action: "get", task: display })) as {
    content: Array<{ text: string }>;
  };
  assert.match(got.content[0]!.text, /in_progress/, "active task state restored");
  assert.ok(
    !got.content[0]!.text.includes("createdAt"),
    "restore is bounded, not a transcript dump",
  );
  h.cleanup();
  h2.cleanup();
});

test("[T3] waiting on a job resumes automatically via pinx.runtime.job — no polling", async () => {
  const h = harness();
  const display = await createTask(h, "Ship after build");
  const tool = taskTool(h);
  await tool.execute(undefined, { action: "start", task: display });
  await tool.execute(undefined, { action: "wait", task: display, kind: "job", ref: "job_0042" });

  // No polling: nothing wakes the task until the contract event arrives.
  await h.dispatch("turn_end", {});
  const before = (await tool.execute(undefined, { action: "get", task: display })) as {
    content: Array<{ text: string }>;
  };
  assert.match(before.content[0]!.text, /waiting: job/);

  h.emitBus("pinx.runtime.job", {
    v: 1,
    jobId: "job_0042",
    label: "build",
    runtime: "node",
    state: "completed",
    exitCode: 0,
  });
  const after = (await tool.execute(undefined, { action: "get", task: display })) as {
    content: Array<{ text: string }>;
  };
  assert.match(after.content[0]!.text, /in_progress/, "job completion ≠ task completion");
  assert.doesNotMatch(after.content[0]!.text, /waiting: job/);
  h.cleanup();
});

test("[T3] failed job blocks the task with the failure reference", async () => {
  const h = harness();
  const display = await createTask(h, "Ship after test run");
  const tool = taskTool(h);
  await tool.execute(undefined, { action: "start", task: display });
  await tool.execute(undefined, { action: "wait", task: display, kind: "job", ref: "job_0007" });
  h.emitBus("pinx.runtime.job", {
    v: 1,
    jobId: "job_0007",
    label: "test",
    runtime: "node",
    state: "failed",
    exitCode: 1,
  });
  const got = (await tool.execute(undefined, { action: "get", task: display })) as {
    content: Array<{ text: string }>;
  };
  assert.match(got.content[0]!.text, /blocked/);
  assert.match(got.content[0]!.text, /exit 1/);
  h.cleanup();
});

test("[T3] approval waits resolve only on an exact-digest allow; denial blocks", async () => {
  const h = harness();
  const tool = taskTool(h);
  const display = await createTask(h, "Delete after approval");
  await tool.execute(undefined, { action: "start", task: display });
  await tool.execute(undefined, {
    action: "wait",
    task: display,
    kind: "approval",
    ref: "digestAAA",
  });

  // A DIFFERENT digest being approved must NOT resume the task (P2/T3).
  h.emitBus("pinx.policy.decision", { v: 1, digest: "digestBBB", decision: "allow" });
  const stale = (await tool.execute(undefined, { action: "get", task: display })) as {
    content: Array<{ text: string }>;
  };
  assert.match(stale.content[0]!.text, /waiting: approval/, "stale/different digest never resumes");

  // Exact-digest deny blocks.
  h.emitBus("pinx.policy.decision", { v: 1, digest: "digestAAA", decision: "deny" });
  const denied = (await tool.execute(undefined, { action: "get", task: display })) as {
    content: Array<{ text: string }>;
  };
  assert.match(denied.content[0]!.text, /blocked/, "denial blocks, never silently resumes");
  h.cleanup();
});

test("[T7] context injection is byte-stable when nothing changed; absent with no tasks", async () => {
  const h = harness();
  // No tasks: no injection at all (§13 no-task overhead = zero).
  const empty = await h.dispatch("context", { messages: [] });
  assert.equal(empty, undefined);

  const display = await createTask(h, "Stable projection");
  const tool = taskTool(h);
  await tool.execute(undefined, { action: "start", task: display });

  const injection1 = (await h.dispatch("context", { messages: [] })) as {
    messages: Array<{ content: string; timestamp: number }>;
  };
  const injection2 = (await h.dispatch("context", { messages: [] })) as {
    messages: Array<{ content: string }>;
  };
  const block1 = injection1.messages.at(-1)!.content as string;
  const block2 = injection2.messages.at(-1)!.content as string;
  assert.match(block1, /^\[tasks\]/);
  assert.match(block1, /in_progress: Stable projection/);
  assert.equal(block1, block2, "byte-identical across calls when state unchanged");
  assert.equal(injection1.messages.at(-1)!.timestamp, 0, "no ticking timestamps");
  h.cleanup();
});

test("[T5] turn_end commits a checkpoint AFTER mutations are persisted", async () => {
  const h = harness();
  await h.dispatch("session_start", { reason: "startup" });
  await createTask(h, "Checkpoint ordering");
  await h.dispatch("turn_end", {});
  const types = h.appended.map((a) => a.customType);
  const lastMutation = types.lastIndexOf("pinx.task.mutation");
  const checkpointIdx = types.lastIndexOf("pinx.task.checkpoint");
  assert.ok(checkpointIdx > lastMutation, "checkpoint written after the state it claims");
  const cpEntry = h.appended[checkpointIdx]!.data as { checkpoint: TaskCheckpoint };
  assert.equal(cpEntry.checkpoint.v, 1);
  assert.equal(cpEntry.checkpoint.activeTaskIds.length, 1);
  h.cleanup();
});

test("[T] mutations are write-behind-safe: a failed apply leaves no log entry", async () => {
  const h = harness();
  const tool = taskTool(h);
  // invalid transition on a nonexistent task fails without appending
  const bad = (await tool.execute(undefined, { action: "start", task: "T99" })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]!.text, /TASK_NOT_FOUND/);
  assert.equal(h.appended.length, 0, "no poison record persisted");
  h.cleanup();
});

test("[T] task tool registers with bounded schema; list truncates explicitly", async () => {
  const h = harness();
  assert.ok(
    h.registeredTools.some((t) => t.name === "task"),
    "task tool present",
  );
  assert.ok(
    h.registeredTools.some((t) => t.name === "issue_candidate"),
    "issue tool present",
  );
  const tool = taskTool(h);
  for (let i = 0; i < 45; i++) await createTask(h, `Filler task number ${i}`);
  const list = (await tool.execute(undefined, { action: "list" })) as {
    content: Array<{ text: string }>;
  };
  assert.match(list.content[0]!.text, /older tasks omitted/, "explicit truncation, never silent");
  h.cleanup();
});
