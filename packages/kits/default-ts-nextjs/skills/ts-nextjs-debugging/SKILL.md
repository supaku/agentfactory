# SKILL: TypeScript / Next.js Debugging

**id**: ts-nextjs-debugging
**version**: 1.0.0
**conformsTo**: agentskills.io/specification/v1

## Overview

Debugging TypeScript and Next.js build and runtime errors. This skill provides
systematic diagnosis workflows for the most common failure modes in TS/Next.js
projects.

## Triggers

Use this skill when:
- TypeScript type errors block `pnpm build` or `pnpm typecheck`
- Next.js build fails with module resolution or RSC boundary errors
- Test failures indicate type or import mismatches
- Hydration errors appear in the browser console

## Debugging Workflow

### 1. Type Errors

```
pnpm typecheck 2>&1 | head -50
```

Read the first error. TypeScript errors often cascade — fix the root cause first.

**Common root causes:**
- Missing `export type` on re-exported types (fix: `export type { Foo }`)
- Incorrect return type annotations (fix: infer from implementation)
- Missing dependencies in `@types/*` packages
- Circular imports (fix: break the cycle with an interface or barrel file)

### 2. Build Failures

```
pnpm build 2>&1 | tail -80
```

**Common root causes:**
- Server/Client Component boundary violations (`'use client'` missing)
- Dynamic imports with `ssr: false` in Server Components
- Missing environment variables (check `.env.local`)
- Invalid image `src` domains in `next.config`

### 3. Test Failures

```
pnpm test -- --reporter=verbose 2>&1 | grep -E "FAIL|Error" | head -30
```

**Common root causes:**
- Missing test environment setup (check `vitest.config.ts` or `jest.config.ts`)
- Module not found — check `moduleNameMapper` or `resolve.alias`
- Async test timeouts — add `{ timeout: 10000 }` to `it()`

## Self-Hosting Check

This kit detects this repo (agentfactory) when:
- `package.json` exists (it does)
- A `next.config.*` file is present OR `package.json#dependencies.next` is set

The agentfactory monorepo itself contains a `packages/nextjs` package that
references Next.js, which is why the default TS/Next.js kit self-matches.
