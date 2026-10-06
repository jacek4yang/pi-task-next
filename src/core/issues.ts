// Issue candidates (§24-25): persistent project problems worth future
// externalization. Deliberately separate from tasks (tasks = execution
// work; issue candidates = durable problems). Local durable store only —
// NO GitHub mutation here; promotion is a future pi-github-next flow.
//
// Storage: one versioned JSON file per project (hash of cwd) under the
// agent dir, atomic writes (tmp + rename), validated load, bounded size.
// Corruption fails closed to an empty healthy store with a degraded flag
// (T6) — never crashes Pi.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { taskError } from "./machine.ts";
import type { IssueCandidate } from "./types.ts";
import { STACK_INFO } from "../info.ts";

const Q = STACK_INFO.quotas;
const MAX_ISSUES = 32;

interface IssueFile {
  v: 1;
  issues: IssueCandidate[];
}

export function issueStorePath(agentDir: string, cwd: string): string {
  const hash = createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 16);
  return join(agentDir, "pinx", "task-next", `issues-${hash}.json`);
}

export function validateIssue(issue: IssueCandidate): void {
  if (issue.v !== 1) throw taskError("TASK_STORE_CORRUPT", "unsupported issue schema version");
  if (!issue.id || typeof issue.id !== "string")
    throw taskError("TASK_STORE_CORRUPT", "issue id missing");
  if (!issue.title || issue.title.length > Q.maxTitleLength) {
    throw taskError("TASK_QUOTA_EXCEEDED", `issue title must be 1..${Q.maxTitleLength} chars`);
  }
  if (issue.description.length > Q.maxNoteLength) {
    throw taskError("TASK_QUOTA_EXCEEDED", `issue description must be <= ${Q.maxNoteLength} chars`);
  }
  if (issue.sourceRefs.length > Q.maxRefsPerTask) {
    throw taskError("TASK_QUOTA_EXCEEDED", `issue sourceRefs exceed ${Q.maxRefsPerTask}`);
  }
}

export class IssueStore {
  private issues: IssueCandidate[] = [];
  degraded: string | undefined;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return; // first use — empty store
    }
    try {
      const parsed = JSON.parse(raw) as IssueFile;
      if (parsed.v !== 1 || !Array.isArray(parsed.issues)) {
        throw new Error("bad schema");
      }
      for (const issue of parsed.issues) validateIssue(issue);
      if (parsed.issues.length > MAX_ISSUES) {
        parsed.issues.length = MAX_ISSUES; // bounded retention, oldest dropped implicitly by order
      }
      this.issues = parsed.issues;
      this.degraded = undefined;
    } catch (error) {
      // Fail closed: keep the corrupt file untouched, start empty (T6).
      this.issues = [];
      this.degraded = `issue store corrupt: ${(error as Error).message}`;
    }
  }

  list(): IssueCandidate[] {
    return [...this.issues];
  }

  open(): IssueCandidate[] {
    return this.issues.filter((i) => i.state === "open");
  }

  async add(input: {
    title: string;
    description: string;
    sourceRefs?: string[];
  }): Promise<IssueCandidate> {
    const issue: IssueCandidate = {
      v: 1,
      id: `issue_${this.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      title: input.title,
      description: input.description,
      sourceRefs: (input.sourceRefs ?? []).slice(0, Q.maxRefsPerTask),
      state: "open",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    validateIssue(issue);
    if (this.issues.length >= MAX_ISSUES) {
      throw taskError(
        "TASK_QUOTA_EXCEEDED",
        `issue store full (${MAX_ISSUES}); dismiss or promote first`,
      );
    }
    this.issues.push(issue);
    await this.persist();
    return issue;
  }

  async dismiss(id: string): Promise<IssueCandidate> {
    return this.setState(id, "dismissed");
  }

  async markPromoted(id: string): Promise<IssueCandidate> {
    return this.setState(id, "promoted");
  }

  private async setState(id: string, state: IssueCandidate["state"]): Promise<IssueCandidate> {
    const issue = this.issues.find((i) => i.id === id);
    if (!issue) throw taskError("TASK_NOT_FOUND", `no issue candidate ${id}`);
    issue.state = state;
    issue.updatedAt = this.now();
    await this.persist();
    return issue;
  }

  private async persist(): Promise<void> {
    const payload: IssueFile = { v: 1, issues: this.issues };
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.path);
  }
}
