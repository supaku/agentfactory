@echo off
REM Kit post-acquire hook: TypeScript / Next.js (Windows)
REM Runs once after the workarea is acquired and ready.

echo [ts-nextjs kit] post_acquire: checking workarea...

IF NOT EXIST node_modules (
  echo [ts-nextjs kit] Installing dependencies...
  where pnpm >nul 2>&1
  IF %ERRORLEVEL% == 0 (
    pnpm install --prefer-offline
  ) ELSE (
    npm install
  )
)

echo [ts-nextjs kit] post_acquire: done.
