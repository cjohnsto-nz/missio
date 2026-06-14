---
name: missio-agent-coordination
description: Coordinate parallel AI agent work on Missio's OpenCollection feature implementation. Use when claiming tasks from docs/open-collection-gap-analysis, updating AGENT_PROGRESS.md, splitting implementation work, reporting blockers, or handing off work between agents in this repository.
---

# Missio Agent Coordination

## Workflow

1. Run `but status -fv` and read the GitButler workspace state.
2. Open `docs/open-collection-gap-analysis/AGENT_PROGRESS.md`.
3. Pick one `Unclaimed` or explicitly handed-off task.
4. Create or identify a GitButler branch/stack for the task with `but branch new <name>` when needed.
5. Set `Status`, `Owner`, `GitButler Branch/Stack/PR`, `Last Update`, and `Next Action` before editing code.
6. Read the matching task file under `docs/open-collection-gap-analysis/tasks/`.
7. Fill in `Coverage Plan` with the automated tests required for the slice before editing implementation code.
8. Work in the smallest coherent slice.
9. Before ending, run the finalization checklist below and append progress notes under that task's log.

## GitButler Rules

- Use the installed GitButler skill named `but` when available.
- If the host does not inject it, read `.opencode/skills/gitbutler/SKILL.md`.
- Use `but` for all version-control writes.
- Never run `git add`, `git commit`, `git push`, `git checkout`, `git merge`, `git rebase`, `git stash`, or `git cherry-pick`.
- Use CLI IDs from `but status -fv`, `but diff`, or `but show`; do not hardcode IDs.
- Prefer `but commit <branch-id> -m "<message>" --changes <id>,<id>` to keep unrelated agent changes out of commits.
- If a file belongs to another applied branch, stack your branch on that dependency with `but move <your-branch> <dependency-branch>` before committing; do not work around dependency locks with raw Git.

## Coordination Rules

- Do not overwrite another agent's table row or log entry unless you are completing an explicit handoff.
- Prefer splitting work in the task log over broad overlapping claims.
- Mark `Blocked` only when a concrete dependency or missing decision prevents progress.
- Include test evidence in the log: command, result, coverage matched to the plan, and any skipped tests.
- Do not set `Review Ready` or `Done` until the coverage plan is satisfied by passing automated tests and the claimed changes are committed to the recorded GitButler branch/stack.
- Document manual-only checks only when automation is not feasible, and create follow-up work for that gap.
- Preserve unrelated user or agent changes in the worktree.

## Finalization Checklist

1. Run `but status -fv` and classify every uncommitted change ID as:
   - `owned`: required for this task.
   - `dependency`: a small supporting fix needed for tests/compile that belongs to another track.
   - `parallel/unrelated`: leave uncommitted and mention it only as context.
2. Commit only `owned` changes to the task branch with `but commit <branch-id> -m "<message>" --changes <ids>`.
3. If `AGENT_PROGRESS.md` or task files are owned by the planning branch, stack the task branch on that branch before committing.
4. Run `but status -fv` after committing and read the returned state; confirm the task branch contains the commit and that remaining unassigned changes are not part of the task.
5. Update `AGENT_PROGRESS.md` with commit evidence, exact verification commands, remaining uncommitted parallel change IDs, and any dependency-only edits.
6. If the work is implemented and tested but not committed, do not mark `Done`; record `Review Ready` or `Blocked` with the exact reason and next GitButler action.

## Handoff Format

When handing off, add a log entry with:

```markdown
- YYYY-MM-DD HH:mm NZT - owner: summary.
  GitButler: branch/stack/PR and any relevant CLI IDs from the last status.
  Coverage: planned tests and whether they are implemented.
  Changed: files or modules touched.
  Verified: commands run and results.
  Next: exact next step or blocker.
```
