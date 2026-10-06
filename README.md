# pi-task-next

Durable long-horizon task state for the [Pi](https://github.com/earendil-works/pi)
coding agent — the second Agent Body v2 productization plugin.

pi-task-next owns the Agent's **operational task layer**: task lifecycle,
hierarchy and dependencies, waiting reasons, bounded task history,
operational checkpoints, a compact deterministic projection, and
reopen/resume continuity. It does NOT own process execution, jobs, CI,
GitHub, approvals, filesystem work, context hygiene, or UI rendering.

## Task model

```
Task { displayId "T3", title, state, priority, parentId?, blockers[],
       dependencies[], waiting?, resourceRefs[], evidenceRefs[], note?, revision }
states:    todo → in_progress → (waiting | blocked)* → done | cancelled
waiting:   job {jobId} · approval {digest} · ci {watchId, reserved} · external {description}
priority:  low · normal · high · critical
```

Transitions are explicit and enumerated — invalid transitions fail with
`INVALID_TRANSITION`, never implicit multi-hops. Every mutation increments a
per-task **revision**; writes carry `expectedRevision` and stale writes fail
with `STALE_REVISION` instead of silently overwriting.

## Persistence (no database)

The durable truth is an **append-only custom-entry mutation log** on the
session branch (`pinx.task.mutation`), replayed branch-sensitively on
`session_start`/`session_tree` — the C16 pattern: reopen restores state by
bounded log replay, never by rereading the transcript, and sibling branches
cannot contaminate the active branch. Operational **checkpoints**
(`pinx.task.checkpoint`, bounded to 8) are commit markers written **after**
the state they claim — a checkpoint never refers to missing tasks (T5).

Issue candidates (`issue_candidate` tool) are a separate durable
project-level store (versioned atomic JSON under the agent dir) for problems
worth externalizing later — never auto-filed to GitHub.

## Waiting is event-driven (never model polling)

- **Jobs** — tasks wait via the versioned `pinx.runtime.job` contract from
  pi-code-runtime-next. Job completion makes the task actionable again
  (completion ≠ objective complete); failure/cancel blocks with the failure
  reference.
- **Approvals** — tasks wait via `pinx.policy.decision` from pi-policy-next.
  Only an approval whose digest matches the task's waiting identity resolves
  it; a materially different action never silently resumes the task (P2).
- **CI** — `waiting.kind="ci"` is a reserved schema placeholder; CI truth
  belongs to the future pi-ci-next. No fake polling exists here.

## Model visibility and cacheability

The active-task projection is injected **transiently** before each LLM call
(Pi `context` event): deterministic bytes, no transcript growth, nothing to
GC. Properties (all regression-tested):

- no tasks → **zero** injected bytes (no empty task block);
- unchanged state → **byte-identical** projection (T7);
- completed/cancelled tasks **leave** hot projection (T4);
- no timestamps, no counters, no opaque internal ids — short display ids,
  titles, state, typed waiting reasons only;
- ordering: active → blocked → waiting → priority-ranked next todos
  (bounded: 3 next, 5 waiting/blocked).

Tool cost is measured and deliberate: `task` (1,675 bytes incl. description)
and `issue_candidate` (518 bytes), both default-active — a long-horizon
layer must be discoverable from turn 0 (see `bench/task-projection.ts`).

## Quotas and GC

Open tasks ≤ 64 · terminal history ≤ 50 (deterministic oldest-first GC,
referenced tasks survive) · checkpoints ≤ 8 · title ≤ 200 chars · notes ≤
500 · refs/blockers/dependencies ≤ 16 each. Oversized values are **rejected,
never silently truncated**. Health (`/task-next`) reports store
healthy/degraded, open/waiting/blocked counts — UI only, never model context.

## Storage rules

Operational facts only. No chain-of-thought, no hidden reasoning, no logs,
no credentials. Errors are explicit (`TASK_NOT_FOUND`, `STALE_REVISION`,
`INVALID_TRANSITION`, `TASK_STORE_CORRUPT`, `TASK_QUOTA_EXCEEDED`,
`INVALID_DEPENDENCY`, `CYCLE`) and corrupt records fail closed to a degraded
health state instead of crashing Pi callbacks (T6).

## Development

```bash
npm ci
npm run ci      # check:pi + typecheck + lint + format + test
npm run bench   # long-horizon soak (630 transitions, reopen cycles) + scenarios
```

Windows and Linux are first-class; Pi is pinned exactly (`check:pi`).
Invariants **T1–T7** are test-tagged and conformance-mapped in the meta
repository (`docs/INVARIANTS.md`).
