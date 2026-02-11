# Contributing to AgentFactory

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

**Prerequisites:** Node.js 22+, pnpm 9+

```bash
# Clone the repo
git clone https://github.com/supaku/agentfactory.git
cd agentfactory

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run type checking
pnpm typecheck

# Run tests
pnpm test
```

## Project Structure

```
packages/
  core/        @supaku/agentfactory              — orchestrator, providers, crash recovery
  linear/      @supaku/agentfactory-linear        — Linear issue tracker integration
  server/      @supaku/agentfactory-server        — Redis queues, session storage, worker pool
  cli/         @supaku/agentfactory-cli           — CLI tools (orchestrator, worker, fleet)
  nextjs/      @supaku/agentfactory-nextjs        — Next.js route handlers, webhook, middleware
  create-app/  @supaku/create-agentfactory-app    — Project scaffolding tool

docs/          Documentation
examples/      Working code samples
```

### Dependency Order

```
linear (no internal deps)
  └── core (depends on linear)
        ├── server (depends on core + linear)
        ├── cli (depends on core + linear + server)
        └── nextjs (depends on core + linear + server)

create-app (no runtime deps — generates code that uses the other packages)
```

Turborepo handles building packages in the correct order.

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes in the appropriate package
3. Run `pnpm build && pnpm typecheck` to verify everything compiles
4. Run `pnpm test` to run the test suite
5. Open a pull request against `main`

### Working on a Single Package

```bash
# Build just one package (and its dependencies)
pnpm --filter @supaku/agentfactory-nextjs build

# Typecheck one package
pnpm --filter @supaku/agentfactory-server typecheck

# Watch mode for tests
pnpm --filter @supaku/agentfactory test:watch
```

### ESM Build Pattern

All packages use ESM with `.js` extensions in relative imports:

```typescript
// Correct — .js extension in source .ts files
import { foo } from './bar.js'

// Incorrect — no extension
import { foo } from './bar'
```

This ensures emitted JS has proper extensions for Node.js ESM compatibility.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Add tests for new functionality
- Update the relevant package's README.md if the public API changes
- Make sure CI passes (typecheck, build, secret scan)

## Adding a New Provider

To add support for a new coding agent:

1. Create `packages/core/src/providers/my-provider.ts`
2. Implement the `AgentProvider` interface
3. Map native SDK events to `AgentEvent` types
4. Add to the provider resolution in `packages/core/src/providers/index.ts`
5. Add tests and documentation

See `packages/core/src/providers/` for existing implementations.

## Reporting Issues

Use [GitHub Issues](https://github.com/supaku/agentfactory/issues) to report bugs or request features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Node.js and pnpm versions
- Which package is affected

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
