/*
 * Copyright 2024-2026 Supaku, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.supaku.agentfactory.bench;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springaicommunity.agents.model.AgentGeneration;
import org.springaicommunity.agents.model.AgentGenerationMetadata;
import org.springaicommunity.agents.model.AgentModel;
import org.springaicommunity.agents.model.AgentResponse;
import org.springaicommunity.agents.model.AgentResponseMetadata;
import org.springaicommunity.agents.model.AgentTaskRequest;

/**
 * AgentModel implementation that bridges Spring AI Bench with the AgentFactory
 * orchestrator. Submits tasks to AF via its CLI and collects results.
 *
 * <p>Integration path: CLI — invokes the AgentFactory orchestrator as a subprocess,
 * passing the task prompt and workspace. The orchestrator handles multi-agent
 * coordination (dev → QA → acceptance pipeline) internally.</p>
 *
 * <p>Usage with Spring AI Bench:</p>
 * <pre>{@code
 * AgentFactoryModel model = AgentFactoryModel.builder()
 *     .orchestratorCommand("pnpm")
 *     .project("Agent")
 *     .build();
 *
 * AgentModelAdapter adapter = new AgentModelAdapter(model, judge);
 * AgentResult result = adapter.run(workspace, spec, timeout);
 * }</pre>
 *
 * @author Supaku AgentFactory
 * @since 0.1.0
 */
public class AgentFactoryModel implements AgentModel {

	private final String orchestratorCommand;
	private final String project;
	private final Path agentFactoryRoot;
	private final Duration defaultTimeout;
	private final boolean multiAgent;
	private final ObjectMapper objectMapper;

	private AgentFactoryModel(Builder builder) {
		this.orchestratorCommand = builder.orchestratorCommand;
		this.project = builder.project;
		this.agentFactoryRoot = builder.agentFactoryRoot;
		this.defaultTimeout = builder.defaultTimeout;
		this.multiAgent = builder.multiAgent;
		this.objectMapper = new ObjectMapper();
	}

	@Override
	public AgentResponse call(AgentTaskRequest request) {
		Instant startTime = Instant.now();
		String sessionId = null;

		try {
			Path workspace = request.workingDirectory();
			Duration timeout = resolveTimeout(request);

			// Build the orchestrator CLI command
			List<String> command = buildCommand(request.goal(), workspace);

			ProcessBuilder pb = new ProcessBuilder(command);
			pb.directory(agentFactoryRoot.toFile());
			pb.redirectErrorStream(true);

			// Pass through environment
			Map<String, String> env = pb.environment();
			if (request.options() != null && request.options().getEnvironmentVariables() != null) {
				env.putAll(request.options().getEnvironmentVariables());
			}

			Process process = pb.start();

			// Collect output and parse JSONL events
			StringBuilder fullOutput = new StringBuilder();
			String lastAssistantText = null;

			try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
				String line;
				while ((line = reader.readLine()) != null) {
					fullOutput.append(line).append("\n");

					// Try to parse JSONL events from orchestrator output
					if (line.startsWith("{")) {
						try {
							JsonNode event = objectMapper.readTree(line);
							String type = event.has("type") ? event.get("type").asText() : "";

							if ("init".equals(type) && event.has("sessionId")) {
								sessionId = event.get("sessionId").asText();
							}
							else if ("assistant_text".equals(type) && event.has("content")) {
								lastAssistantText = event.get("content").asText();
							}
						}
						catch (Exception ignored) {
							// Not all lines are valid JSON events
						}
					}
				}
			}

			boolean completed = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
			if (!completed) {
				process.destroyForcibly();
				return buildErrorResponse("Agent execution timed out after " + timeout, startTime, sessionId);
			}

			int exitCode = process.exitValue();
			Duration duration = Duration.between(startTime, Instant.now());

			String outputText = lastAssistantText != null ? lastAssistantText : fullOutput.toString();
			String finishReason = exitCode == 0 ? "SUCCESS" : "ERROR";

			AgentGenerationMetadata genMeta = new AgentGenerationMetadata(finishReason,
					Map.of("exitCode", exitCode, "success", exitCode == 0, "multiAgent", multiAgent));

			AgentGeneration generation = new AgentGeneration(outputText, genMeta);

			AgentResponseMetadata responseMeta = AgentResponseMetadata.builder()
				.model("agentfactory")
				.duration(duration)
				.sessionId(sessionId != null ? sessionId : "")
				.providerFields(Map.of("project", project, "multiAgent", multiAgent))
				.build();

			return new AgentResponse(List.of(generation), responseMeta);
		}
		catch (IOException e) {
			return buildErrorResponse("Failed to start orchestrator: " + e.getMessage(), startTime, sessionId);
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			return buildErrorResponse("Agent execution interrupted", startTime, sessionId);
		}
	}

	@Override
	public boolean isAvailable() {
		try {
			ProcessBuilder pb = new ProcessBuilder(orchestratorCommand, "--version");
			pb.directory(agentFactoryRoot.toFile());
			Process process = pb.start();
			boolean completed = process.waitFor(10, TimeUnit.SECONDS);
			return completed && process.exitValue() == 0;
		}
		catch (Exception e) {
			return false;
		}
	}

	private List<String> buildCommand(String prompt, Path workspace) {
		List<String> command = new ArrayList<>();
		command.add(orchestratorCommand);
		command.add("orchestrator");
		command.add("--single");
		command.add("BENCH_TASK"); // Placeholder issue ID for bench tasks
		command.add("--project");
		command.add(project);
		command.add("--no-wait");

		return command;
	}

	private Duration resolveTimeout(AgentTaskRequest request) {
		if (request.options() != null && request.options().getTimeout() != null) {
			return request.options().getTimeout();
		}
		return defaultTimeout;
	}

	private AgentResponse buildErrorResponse(String message, Instant startTime, String sessionId) {
		Duration duration = Duration.between(startTime, Instant.now());

		AgentGenerationMetadata genMeta = new AgentGenerationMetadata("ERROR",
				Map.of("success", false, "error", message));

		AgentGeneration generation = new AgentGeneration("Error: " + message, genMeta);

		AgentResponseMetadata responseMeta = AgentResponseMetadata.builder()
			.model("agentfactory")
			.duration(duration)
			.sessionId(sessionId != null ? sessionId : "")
			.build();

		return new AgentResponse(List.of(generation), responseMeta);
	}

	/**
	 * Create a new builder for AgentFactoryModel.
	 * @return a new builder instance
	 */
	public static Builder builder() {
		return new Builder();
	}

	/**
	 * Builder for constructing AgentFactoryModel instances.
	 */
	public static final class Builder {

		private String orchestratorCommand = "pnpm";
		private String project = "Agent";
		private Path agentFactoryRoot = Path.of(".");
		private Duration defaultTimeout = Duration.ofMinutes(30);
		private boolean multiAgent = true;

		private Builder() {
		}

		/**
		 * Set the command to invoke the orchestrator (default: "pnpm").
		 */
		public Builder orchestratorCommand(String orchestratorCommand) {
			this.orchestratorCommand = orchestratorCommand;
			return this;
		}

		/**
		 * Set the Linear project name for issue filtering (default: "Agent").
		 */
		public Builder project(String project) {
			this.project = project;
			return this;
		}

		/**
		 * Set the root directory of the AgentFactory installation.
		 */
		public Builder agentFactoryRoot(Path agentFactoryRoot) {
			this.agentFactoryRoot = agentFactoryRoot;
			return this;
		}

		/**
		 * Set the default timeout for agent execution (default: 30 minutes).
		 */
		public Builder defaultTimeout(Duration defaultTimeout) {
			this.defaultTimeout = defaultTimeout;
			return this;
		}

		/**
		 * Enable or disable multi-agent orchestration (default: true).
		 * When true, AF uses its dev → QA → acceptance pipeline.
		 * When false, uses single-agent mode.
		 */
		public Builder multiAgent(boolean multiAgent) {
			this.multiAgent = multiAgent;
			return this;
		}

		/**
		 * Build the AgentFactoryModel.
		 * @return a configured AgentFactoryModel instance
		 */
		public AgentFactoryModel build() {
			return new AgentFactoryModel(this);
		}
	}

}
