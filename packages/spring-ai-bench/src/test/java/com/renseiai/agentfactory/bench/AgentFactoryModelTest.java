/*
 * Copyright 2024-2026 Rensei AI, Inc.
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
package com.renseiai.agentfactory.bench;

import java.nio.file.Path;
import java.time.Duration;

import org.junit.jupiter.api.Test;
import org.springaicommunity.agents.model.AgentModel;
import org.springaicommunity.agents.model.AgentTaskRequest;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit tests for {@link AgentFactoryModel}.
 */
class AgentFactoryModelTest {

	@Test
	void implementsAgentModelInterface() {
		AgentFactoryModel model = AgentFactoryModel.builder().build();
		assertThat(model).isInstanceOf(AgentModel.class);
	}

	@Test
	void builderSetsDefaults() {
		AgentFactoryModel model = AgentFactoryModel.builder().build();
		assertThat(model).isNotNull();
	}

	@Test
	void builderAcceptsCustomConfiguration() {
		AgentFactoryModel model = AgentFactoryModel.builder()
			.orchestratorCommand("npx")
			.project("TestProject")
			.agentFactoryRoot(Path.of("/tmp/af"))
			.defaultTimeout(Duration.ofMinutes(15))
			.multiAgent(false)
			.build();
		assertThat(model).isNotNull();
	}

	@Test
	void callReturnsResponseWithErrorWhenOrchestratorNotFound() {
		AgentFactoryModel model = AgentFactoryModel.builder()
			.orchestratorCommand("nonexistent-command-xyz")
			.agentFactoryRoot(Path.of("/tmp"))
			.build();

		var request = new AgentTaskRequest("Create hello.txt", Path.of("/tmp"), null);
		var response = model.call(request);

		assertThat(response).isNotNull();
		assertThat(response.getResults()).isNotEmpty();
		assertThat(response.getResult().getMetadata().getFinishReason()).isEqualTo("ERROR");
	}

	@Test
	void isAvailableReturnsFalseWhenOrchestratorNotInstalled() {
		AgentFactoryModel model = AgentFactoryModel.builder()
			.orchestratorCommand("nonexistent-command-xyz")
			.agentFactoryRoot(Path.of("/tmp"))
			.build();
		assertThat(model.isAvailable()).isFalse();
	}

}
