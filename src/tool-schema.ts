// Model-visible tool schemas — single source of truth shared by the wiring
// and the benchmark (measured bytes are exactly what providers see).

import { Type, type TSchema } from "typebox";
import { STACK_INFO } from "./info.ts";

function StringEnum<T extends string>(values: readonly T[]): TSchema {
  return Type.Union(values.map((v) => Type.Literal(v)));
}

export const TASK_TOOL_NAME = STACK_INFO.tool.name;

export const TASK_TOOL_DESCRIPTION =
  "Durable task state: create/start/update/wait/block/resume/complete/cancel tasks and checkpoint operational state. " +
  "Waiting tasks resume automatically when the awaited job or approval resolves — never poll.";

export function taskToolParameters(): TSchema {
  return Type.Object({
    action: StringEnum([
      "create",
      "list",
      "get",
      "start",
      "update",
      "wait",
      "resume",
      "block",
      "complete",
      "cancel",
      "checkpoint",
    ]),
    task: Type.Optional(Type.String({ description: "Task display id (e.g. T3)" })),
    title: Type.Optional(Type.String({ description: "Task title (create/update)" })),
    priority: Type.Optional(StringEnum(["low", "normal", "high", "critical"])),
    parent: Type.Optional(Type.String({ description: "Parent task display id (create)" })),
    note: Type.Optional(Type.String({ description: "Bounded operational note" })),
    kind: Type.Optional(StringEnum(["job", "approval", "ci", "external"])),
    ref: Type.Optional(
      Type.String({
        description: "Wait reference: jobId, approval digest, CI watch id, or short description",
      }),
    ),
    repository: Type.Optional(Type.String({ description: "Checkpoint: current repository" })),
    branch: Type.Optional(Type.String({ description: "Checkpoint: current branch" })),
    headSha: Type.Optional(Type.String({ description: "Checkpoint: current head SHA" })),
    nextAction: Type.Optional(Type.String({ description: "Checkpoint: next action (short fact)" })),
  });
}

export const ISSUE_TOOL_NAME = "issue_candidate";

export const ISSUE_TOOL_DESCRIPTION =
  "Durable local record of a project problem worth externalizing later (issue candidates are NOT tasks and are never auto-filed).";

export function issueToolParameters(): TSchema {
  return Type.Object({
    action: StringEnum(["add", "list", "dismiss"]),
    title: Type.Optional(Type.String({ description: "Short problem title (add)" })),
    description: Type.Optional(Type.String({ description: "One-paragraph description (add)" })),
    id: Type.Optional(Type.String({ description: "Issue candidate id (dismiss)" })),
  });
}

export function toolSchemaBytes(
  parameters: TSchema,
  description: string,
): {
  schemaBytes: number;
  descriptionBytes: number;
  totalBytes: number;
} {
  const schemaBytes = Buffer.byteLength(JSON.stringify(parameters) ?? "", "utf8");
  const descriptionBytes = Buffer.byteLength(description, "utf8");
  return { schemaBytes, descriptionBytes, totalBytes: schemaBytes + descriptionBytes };
}
