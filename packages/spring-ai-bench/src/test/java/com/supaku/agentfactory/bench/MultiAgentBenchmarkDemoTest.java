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

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import com.supaku.agentfactory.bench.runner.AgentFactoryRunner;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springaicommunity.agents.model.AgentGeneration;
import org.springaicommunity.agents.model.AgentGenerationMetadata;
import org.springaicommunity.agents.model.AgentModel;
import org.springaicommunity.agents.model.AgentResponse;
import org.springaicommunity.agents.model.AgentTaskRequest;
import org.springaicommunity.bench.core.spec.AgentSpec;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Demonstration test for multi-agent benchmark pipeline.
 *
 * <p>This test demonstrates how AgentFactory's multi-agent orchestration
 * (dev → QA → acceptance) integrates with Spring AI Bench for evaluation.</p>
 *
 * <p>Tagged as "bench-live" — only runs with explicit profile activation:</p>
 * <pre>
 * mvn test -Pagents-live -Dgroups=bench-live
 * </pre>
 */
class MultiAgentBenchmarkDemoTest {

	@Test
	void singleAgentModelCanBeCreated() {
		AgentFactoryModel singleAgent = AgentFactoryModel.builder()
			.multiAgent(false)
			.project("Agent")
			.defaultTimeout(Duration.ofMinutes(10))
			.build();

		assertThat(singleAgent).isInstanceOf(AgentModel.class);
	}

	@Test
	void multiAgentModelCanBeCreated() {
		AgentFactoryModel multiAgent = AgentFactoryModel.builder()
			.multiAgent(true)
			.project("Agent")
			.defaultTimeout(Duration.ofMinutes(30))
			.build();

		assertThat(multiAgent).isInstanceOf(AgentModel.class);
	}

	@Test
	void runnerCanBeCreatedWithoutJudge() {
		AgentFactoryModel model = AgentFactoryModel.builder().build();
		AgentFactoryRunner runner = new AgentFactoryRunner(model);
		assertThat(runner).isNotNull();
	}

	@Test
	@Tag("bench-live")
	void multiAgentPipelineDemoWithRealOrchestrator() throws Exception {
		// This test requires a running AgentFactory orchestrator
		AgentFactoryModel multiAgent = AgentFactoryModel.builder()
			.orchestratorCommand("pnpm")
			.project("Agent")
			.agentFactoryRoot(Path.of(System.getProperty("af.root", ".")))
			.multiAgent(true)
			.defaultTimeout(Duration.ofMinutes(30))
			.build();

		if (!multiAgent.isAvailable()) {
			System.out.println("SKIP: AgentFactory orchestrator not available");
			return;
		}

		var request = AgentTaskRequest.builder(
				"Add unit tests for the REST controller to achieve 80% coverage",
				Path.of(System.getProperty("bench.workspace", "/tmp/bench-workspace")))
			.build();

		AgentResponse response = multiAgent.call(request);

		assertThat(response).isNotNull();
		assertThat(response.getResults()).isNotEmpty();

		AgentGeneration result = response.getResult();
		System.out.println("Result: " + result.getMetadata().getFinishReason());
		System.out.println("Output: " + result.getOutput().substring(0, Math.min(200, result.getOutput().length())));
		System.out.println("Duration: " + response.getMetadata().getDuration());
		System.out.println("Session: " + response.getMetadata().getSessionId());
	}

	@Test
	void compareConfigurationsDemo() {
		// Demonstrates the comparison pattern used in benchmark runs
		AgentSpec singleAgentSpec = AgentSpec.builder()
			.kind("agentfactory-single")
			.prompt("Add tests for REST controller")
			.build();

		AgentSpec multiAgentSpec = AgentSpec.builder()
			.kind("agentfactory")
			.prompt("Add tests for REST controller")
			.build();

		assertThat(singleAgentSpec.kind()).isEqualTo("agentfactory-single");
		assertThat(multiAgentSpec.kind()).isEqualTo("agentfactory");
	}

}
