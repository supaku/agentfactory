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

import com.supaku.agentfactory.bench.AgentFactoryModel;
import org.springaicommunity.bench.core.run.AgentRunner;
import org.springaicommunity.judge.Judge;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Auto-configuration for AgentFactory as a Spring AI Bench agent provider.
 * Conditionally creates the AgentFactory runner when configured.
 *
 * <p>Enable via application properties:</p>
 * <pre>
 * spring.ai.bench.agent.provider=agentfactory
 * </pre>
 *
 * @author Supaku AgentFactory
 * @since 0.1.0
 */
@Configuration
public class AgentFactoryProviderConfig {

	@Bean
	@ConditionalOnClass(AgentFactoryModel.class)
	@ConditionalOnMissingBean(AgentRunner.class)
	@ConditionalOnProperty(name = "spring.ai.bench.agent.provider", havingValue = "agentfactory")
	public AgentRunner agentFactoryRunner(AgentFactoryModel model, Judge judge) {
		return new AgentFactoryRunner(model, judge);
	}

}
