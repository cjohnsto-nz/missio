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
9. Append progress notes under that task's log before ending the session.

## GitButler Rules

- Use the installed GitButler skill named `but` when available.
- If the host does not inject it, read `.opencode/skills/gitbutler/SKILL.md`.
- Use `but` for all version-control writes.
- Never run `git add`, `git commit`, `git push`, `git checkout`, `git merge`, `git rebase`, `git stash`, or `git cherry-pick`.
- Use CLI IDs from `but status -fv`, `but diff`, or `but show`; do not hardcode IDs.
- Prefer `but commit <branch-id> -m "<message>" --changes <id>,<id>` to keep unrelated agent changes out of commits.

## Coordination Rules

- Do not overwrite another agent's table row or log entry unless you are completing an explicit handoff.
- Prefer splitting work in the task log over broad overlapping claims.
- Mark `Blocked` only when a concrete dependency or missing decision prevents progress.
- Include test evidence in the log: command, result, coverage matched to the plan, and any skipped tests.
- Do not set `Review Ready` or `Done` until the coverage plan is satisfied by passing automated tests.
- Document manual-only checks only when automation is not feasible, and create follow-up work for that gap.
- Preserve unrelated user or agent changes in the worktree.

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
