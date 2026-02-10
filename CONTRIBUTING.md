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
  core/      @supaku/agentfactory          — orchestrator, providers, crash recovery
  linear/    @supaku/agentfactory-linear   — Linear issue tracker integration
  server/    @supaku/agentfactory-server   — Redis queues, worker pool
  cli/       @supaku/agentfactory-cli      — CLI tools
```

Packages have a dependency order: **linear** -> **core** -> **server** / **cli**. Turborepo handles building them in the correct order.

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm build && pnpm typecheck` to verify everything compiles
4. Run `pnpm test` to run the test suite
5. Open a pull request against `main`

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Add tests for new functionality
- Make sure CI passes (typecheck, build, secret scan)

## Reporting Issues

Use [GitHub Issues](https://github.com/supaku/agentfactory/issues) to report bugs or request features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Node.js and pnpm versions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
