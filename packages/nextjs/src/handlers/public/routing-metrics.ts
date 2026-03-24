/**
 * GET /api/public/routing-metrics
 *
 * Returns routing performance data (posteriors, recent decisions, summary).
 */

import { NextResponse } from 'next/server'
import {
  RedisPosteriorStore,
  createRedisObservationStore,
  createLogger,
} from '@renseiai/agentfactory-server'
import { betaMean, betaVariance } from '@renseiai/agentfactory'

const log = createLogger('api/public/routing-metrics')

export interface PublicRoutingMetricsResponse {
  posteriors: Array<{
    provider: string
    workType: string
    alpha: number
    beta: number
    expectedReward: number
    confidence: number
    totalObservations: number
    avgCostUsd: number
  }>
  recentDecisions: Array<{
    timestamp: number
    provider: string
    workType: string
    reward: number
    taskCompleted: boolean
    confidence: number
    explorationReason?: string
  }>
  summary: {
    totalObservations: number
    routingEnabled: boolean
    explorationRate: number
    avgConfidence: number
  }
  timestamp: string
}

export function createPublicRoutingMetricsHandler() {
  const posteriorStore = new RedisPosteriorStore()
  const observationStore = createRedisObservationStore()

  return async function GET() {
    try {
      const [allPosteriors, recentObservations] = await Promise.all([
        posteriorStore.getAllPosteriors(),
        observationStore.getObservations({ limit: 50 }),
      ])

      const posteriors = allPosteriors.map((p) => {
        const expectedReward = betaMean(p.alpha, p.beta)
        const variance = betaVariance(p.alpha, p.beta)
        const confidence = 1 - Math.sqrt(variance)

        return {
          provider: p.provider,
          workType: p.workType,
          alpha: p.alpha,
          beta: p.beta,
          expectedReward: Math.round(expectedReward * 10000) / 10000,
          confidence: Math.round(confidence * 10000) / 10000,
          totalObservations: p.totalObservations,
          avgCostUsd: Math.round(p.avgCostUsd * 10000) / 10000,
        }
      })

      const recentDecisions = recentObservations.map((obs) => ({
        timestamp: obs.timestamp,
        provider: obs.provider,
        workType: obs.workType,
        reward: obs.reward,
        taskCompleted: obs.taskCompleted,
        confidence: obs.confidence,
        ...(obs.explorationReason !== undefined
          ? { explorationReason: obs.explorationReason }
          : {}),
      }))

      const totalObservations = allPosteriors.reduce(
        (sum, p) => sum + p.totalObservations,
        0,
      )

      const confidences = posteriors.map((p) => p.confidence)
      const avgConfidence =
        confidences.length > 0
          ? Math.round(
              (confidences.reduce((s, c) => s + c, 0) / confidences.length) *
                10000,
            ) / 10000
          : 0

      // Routing is considered enabled if we have any posteriors with observations
      const routingEnabled = allPosteriors.some(
        (p) => p.totalObservations > 0,
      )

      const response: PublicRoutingMetricsResponse = {
        posteriors,
        recentDecisions,
        summary: {
          totalObservations,
          routingEnabled,
          explorationRate: 0.1, // default; config.yaml not accessible from API handler
          avgConfidence,
        },
        timestamp: new Date().toISOString(),
      }

      return NextResponse.json(response)
    } catch (error) {
      log.error('Failed to get routing metrics', { error })

      return NextResponse.json(
        {
          posteriors: [],
          recentDecisions: [],
          summary: {
            totalObservations: 0,
            routingEnabled: false,
            explorationRate: 0,
            avgConfidence: 0,
          },
          error: 'Failed to fetch routing metrics',
          timestamp: new Date().toISOString(),
        },
        { status: 500 },
      )
    }
  }
}
