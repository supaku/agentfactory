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
package com.supaku.agentfactory.bench.runner;

import java.nio.file.Path;
import java.time.Duration;

import com.supaku.agentfactory.bench.AgentFactoryModel;
import org.springaicommunity.bench.agents.runner.AgentModelAdapter;
import org.springaicommunity.bench.core.run.AgentResult;
import org.springaicommunity.bench.core.run.AgentRunner;
import org.springaicommunity.bench.core.spec.AgentSpec;
import org.springaicommunity.judge.Judge;

/**
 * AgentRunner implementation for AgentFactory. Wraps {@link AgentFactoryModel}
 * with the {@link AgentModelAdapter} to bridge between Spring AI Bench and
 * the AgentFactory orchestrator.
 *
 * <p>Follows the same pattern as {@code ClaudeCodeAgentRunner} and
 * {@code GeminiAgentRunner} in the bench-agents module.</p>
 *
 * @author Supaku AgentFactory
 * @since 0.1.0
 */
public class AgentFactoryRunner implements AgentRunner {

	private final AgentModelAdapter adapter;

	public AgentFactoryRunner(AgentFactoryModel model, Judge judge) {
		this.adapter = new AgentModelAdapter(model, judge);
	}

	public AgentFactoryRunner(AgentFactoryModel model) {
		this.adapter = new AgentModelAdapter(model);
	}

	@Override
	public AgentResult run(Path workspace, AgentSpec spec, Duration timeout) throws Exception {
		return adapter.run(workspace, spec, timeout);
	}

}
