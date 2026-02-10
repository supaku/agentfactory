# Agent Definitions

Agent definitions tell coding agents **how to behave** for each work type in the AgentFactory pipeline. They are markdown files with YAML frontmatter that the orchestrator uses to configure agent behavior.

## How It Works

When AgentFactory spawns an agent for an issue, it selects an agent definition based on the **work type** (development, QA, acceptance, coordination). The definition is injected as system instructions that guide the agent's behavior.

```
Issue enters pipeline
  -> Orchestrator determines work type from issue status
  -> Selects agent definition for that work type
  -> Spawns coding agent with definition as instructions
  -> Agent follows the workflow defined in the markdown
```

## Included Definitions

| Definition | Work Type | Purpose |
|-----------|-----------|---------|
| [developer.md](./developer.md) | `development` | Implements features, fixes bugs, creates PRs |
| [qa-reviewer.md](./qa-reviewer.md) | `qa` | Validates implementation, runs tests, checks regressions |
| [coordinator.md](./coordinator.md) | `coordination` | Orchestrates parallel sub-issues via Task sub-agents |
| [acceptance-handler.md](./acceptance-handler.md) | `acceptance` | Validates completion, merges PRs, cleans up |
| [backlog-writer.md](./backlog-writer.md) | `planning` | Transforms plans into structured Linear issues |

## Definition Format

```markdown
---
name: agent-name
description: When to use this agent and what it does.
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
---

# Agent Title

Brief description of the agent's role.

## Workflow

1. Step 1
2. Step 2
3. ...

## [Domain-Specific Sections]

Instructions, checklists, commands, and patterns.

## Structured Result Marker (REQUIRED)

- On success: `<!-- WORK_RESULT:passed -->`
- On failure: `<!-- WORK_RESULT:failed -->`
```

### Frontmatter Fields

| Field | Description |
|-------|-------------|
| `name` | Unique identifier for the agent |
| `description` | When the orchestrator should select this agent |
| `tools` | Comma-separated list of allowed tools |
| `model` | Which model to use (`opus`, `sonnet`, `haiku`) |

### The Result Marker

The orchestrator parses agent output for `<!-- WORK_RESULT:passed -->` or `<!-- WORK_RESULT:failed -->` to determine whether to promote the issue to the next status. Without this marker, the issue status won't be updated automatically.

## Customizing for Your Project

These definitions are starting points. You should customize them for your stack:

1. **Add project-specific commands** — replace generic `pnpm turbo run test` with your actual test commands
2. **Add framework-specific agents** — create `nextjs-developer.md`, `rails-developer.md`, etc. for specialized knowledge
3. **Add deployment checks** — if using Vercel/Netlify/etc., add deployment verification to QA
4. **Add database validation** — if using migrations, add schema drift checks
5. **Tune the review checklist** — add checks specific to your codebase (e.g., i18n, accessibility)

### Creating Specialized Developer Agents

For larger projects, create multiple developer agents specialized by domain:

```markdown
---
name: frontend-developer
description: Use for issues touching React components, pages, and UI.
tools: Read, Edit, Write, Grep, Glob, Bash
model: opus
---

# Frontend Developer

Expert in React/Next.js development for this project.

## Key Patterns
- [Your component patterns]
- [Your state management approach]
- [Your styling conventions]
```

The orchestrator can select the right developer agent based on issue labels, project, or file paths affected.

## Placement

Place your agent definitions in `.claude/agents/` at the root of your repository. AgentFactory looks for them there by default, or you can configure a custom path in the orchestrator config.
