# AgentFactory Spring AI Bench Integration

Bridges AgentFactory's multi-agent orchestrator with [Spring AI Bench](https://github.com/spring-ai-community/spring-ai-bench) evaluation framework.

## Overview

This module provides:

1. **`AgentFactoryModel`** — Implements the `AgentModel` interface from [spring-ai-agents](https://github.com/spring-ai-community/spring-ai-agents), allowing Spring AI Bench to invoke AgentFactory as an agent provider
2. **`AgentFactoryRunner`** — Wraps the model with `AgentModelAdapter` for bench harness integration
3. **Agent configs** — YAML configurations for Spring AI Bench CLI
4. **Benchmark tracks** — Demo benchmark for coverage uplift with multi-agent pipeline

## Architecture

```
Spring AI Bench
  └─ AgentModelAdapter
       └─ AgentFactoryModel (this module)
            └─ AF Orchestrator CLI
                 ├─ Dev Agent    (implementation)
                 ├─ QA Agent     (validation)
                 └─ Acceptance Agent (final check)
```

## Prerequisites

- Java 21+
- Node.js 22+ with pnpm (for AgentFactory CLI)
- AgentFactory installed and configured
- Spring AI Bench and spring-ai-agents built locally (SNAPSHOT dependencies)

## Building

```bash
# Build spring-ai-agents first (SNAPSHOT dependency)
cd /path/to/spring-ai-agents && mvn install -DskipTests

# Build spring-ai-bench (SNAPSHOT dependency)
cd /path/to/spring-ai-bench && mvn install -DskipTests

# Build this module
cd packages/spring-ai-bench && mvn package
```

## Usage

### As AgentModel (programmatic)

```java
AgentFactoryModel model = AgentFactoryModel.builder()
    .orchestratorCommand("pnpm")
    .project("Agent")
    .agentFactoryRoot(Path.of("/path/to/agentfactory"))
    .multiAgent(true)  // Use dev → QA → acceptance pipeline
    .build();

var request = new AgentTaskRequest("Fix the failing test in UserServiceTest", workspace, null);
AgentResponse response = model.call(request);
```

### With Spring AI Bench CLI

```bash
# Single-agent mode
spring-ai-bench run hello-world --agent agents/agentfactory-single.yaml

# Multi-agent mode (orchestrator)
spring-ai-bench run coverage-uplift --agent agents/agentfactory.yaml
```

### As Spring Boot bean

```properties
spring.ai.bench.agent.provider=agentfactory
```

## Benchmark Tracks

### Coverage Uplift

Demonstrates multi-agent pipeline improving test coverage:

```bash
spring-ai-bench run coverage-uplift --agent agents/agentfactory.yaml
```

Pipeline: Dev agent writes tests → QA agent validates → Acceptance agent verifies coverage target.

## Comparing Single vs Multi-Agent

Run the same benchmark with both modes:

```bash
# Single agent
spring-ai-bench run coverage-uplift --agent agents/agentfactory-single.yaml

# Multi-agent
spring-ai-bench run coverage-uplift --agent agents/agentfactory.yaml
```

Compare `runs/*/result.json` for accuracy, duration, and reliability metrics.
