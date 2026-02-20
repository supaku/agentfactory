# PM Curation Workflow — Workflow Governor

The Workflow Governor autonomously processes Icebox issues through research and backlog creation. PMs curate this pipeline using structured directives and by controlling issue content, without needing to @mention agents for routine transitions.

## How the Top-of-Funnel Works

When the Governor scans a project, Icebox issues are evaluated in two stages:

1. **Research** — Issues with sparse descriptions (under 200 characters or missing structured headers like `## Acceptance Criteria`, `## Technical Approach`) are dispatched to a research agent after a configurable delay (default: 1 hour in Icebox).

2. **Backlog Creation** — Issues with well-researched descriptions are dispatched to a backlog-creation agent, which may decompose them into sub-issues or promote them to Backlog status.

Issues that have already completed research or backlog creation are not re-triggered.

## PM Interaction Points

### Adding Issues to Icebox

PMs add issues to Icebox with an initial description. The Governor handles the rest:

- **Sparse description** — The Governor auto-triggers research to flesh out requirements, acceptance criteria, and technical approach.
- **Detailed description** — If the PM provides a thorough write-up with structured headers, the Governor skips research and proceeds directly to backlog creation.

### Using Directives

PMs can post structured comments on any issue to override the Governor's behavior. Directives must appear at the start of a comment (case-insensitive):

| Directive | Effect |
|-----------|--------|
| `HOLD` | Pauses all autonomous processing. Use when you want to review or edit the issue before agents proceed. |
| `HOLD — reason` | Same as HOLD, with a recorded reason. |
| `RESUME` | Clears a HOLD, allowing the Governor to resume autonomous processing. |
| `PRIORITY: high` | Bumps the issue to the front of the dispatch queue. When the Governor has more actionable issues than its dispatch limit allows, high-priority issues are dispatched first. |
| `PRIORITY: medium` | Dispatched after high-priority but before low-priority and untagged issues. |
| `PRIORITY: low` | Dispatched after all higher-priority and untagged issues. |
| `DECOMPOSE` | Triggers task decomposition regardless of cycle count. |
| `REASSIGN` | Stops all agent work on the issue, signaling it needs human assignment. |
| `SKIP QA` | Skips automated QA and proceeds directly to acceptance. |

### Reviewing Before Research

To review an issue before research begins:

1. Add the issue to Icebox with your initial description.
2. Immediately comment `HOLD` on the issue.
3. Refine the description at your own pace.
4. When ready, comment `RESUME` to let the Governor proceed.

### Influencing Research Priority

When the Governor has multiple Icebox issues eligible for research but limited dispatch slots:

1. Comment `PRIORITY: high` on the most important issues.
2. These will be researched first, even if they were added to Icebox after other issues.

### Editing Researched Descriptions

After the research agent updates an issue description:

1. The Governor detects the issue now has a well-researched description.
2. Before backlog creation triggers, the PM can comment `HOLD` to review and edit.
3. The PM edits acceptance criteria, adds business context, or adjusts scope.
4. Comment `RESUME` to allow backlog creation to proceed.

### Adding Context for Agents

PMs can add comments with additional context that agents will see:

- Business requirements not in the description
- Links to design documents or specifications
- Clarifications on scope or expected behavior

These comments are visible to agents when they process the issue.

## Configuring Research-Readiness Thresholds

The heuristics that determine whether an issue needs research are configurable via `GovernorConfig.topOfFunnel`:

| Setting | Default | Description |
|---------|---------|-------------|
| `iceboxResearchDelayMs` | 3,600,000 (1 hour) | How long an issue must be in Icebox before research triggers |
| `minResearchedDescriptionLength` | 200 | Minimum character count for a description to be considered "well-researched" |
| `researchedHeaders` | `## Acceptance Criteria`, `## Technical Approach`, `## Summary`, `## Design`, `## Requirements` | Headers that indicate a well-researched description |
| `researchRequestLabels` | `Needs Research` | Labels that explicitly request research regardless of description quality |

Example configuration:

```typescript
const governor = new WorkflowGovernor({
  projects: ['MyProject'],
  topOfFunnel: {
    iceboxResearchDelayMs: 30 * 60 * 1000, // 30 minutes
    minResearchedDescriptionLength: 300,
    researchRequestLabels: ['Needs Research', 'Investigate'],
  },
}, deps)
```

## Workflow Diagram

```
PM adds issue to Icebox
         │
         ▼
  ┌──────────────────┐
  │ Governor scans    │
  │ Icebox issues     │
  └────────┬─────────┘
           │
     ┌─────▼─────┐     HOLD?
     │ Is issue   │────────────▶ Paused (wait for RESUME)
     │ held?      │
     └─────┬─────┘
           │ No
     ┌─────▼──────────┐
     │ Well-researched?│
     └──┬──────────┬──┘
        │ No       │ Yes
        ▼          ▼
   Research    Backlog Creation
     Agent        Agent
        │          │
        ▼          ▼
   Description   Sub-issues created
   updated       or issue → Backlog
        │
        ▼
   Backlog Creation
     (next scan)
```
