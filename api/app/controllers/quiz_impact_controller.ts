import type { HttpContext } from '@adonisjs/core/http'
import ApiException from '#exceptions/api_exception'
import { METRICS, METRIC_BY_KEY } from '#services/analytics/quiz_metrics'
import quizMetricsStore from '#services/analytics/quiz_metrics_store'
import quizReleases, { type ReleaseInput } from '#services/analytics/quiz_releases'
import { quizMetricSeriesValidator, quizReleaseDeleteValidator, quizReleaseValidator } from '#validators/console'

/**
 * Quiz before/after tracking (docs/QUIZ_OBSERVABILITY.md §7): the release log and the frozen
 * daily metrics. Cost metrics need the cost permission, like the Cost page.
 */
export default class QuizImpactController {
  private input(body: Awaited<ReturnType<typeof quizReleaseValidator.validate>>): ReleaseInput {
    return {
      title: body.title,
      phase: body.phase ?? null,
      kind: body.kind,
      surface: body.surface,
      ticket: body.ticket ?? null,
      pr: body.pr ?? null,
      commitSha: body.commit_sha ?? null,
      appVersion: body.app_version ?? null,
      deployedAt: body.deployed_at ?? null,
      deployedEstimated: body.deployed_estimated ?? false,
      expects: body.expects ?? null,
      notes: body.notes ?? null,
    }
  }

  async releases() {
    return { releases: await quizReleases.list() }
  }

  async createRelease({ request, actor }: HttpContext) {
    const body = await request.validateUsing(quizReleaseValidator)
    return { release: await quizReleases.create(actor, this.input(body)) }
  }

  async updateRelease({ request, params, actor }: HttpContext) {
    const body = await request.validateUsing(quizReleaseValidator)
    return { release: await quizReleases.update(actor, Number(params.id), this.input(body)) }
  }

  async deleteRelease({ request, params, actor }: HttpContext) {
    const { reason } = await request.validateUsing(quizReleaseDeleteValidator)
    await quizReleases.remove(actor, Number(params.id), reason)
    return { ok: true }
  }

  /** What the baseline holds and the metric catalog (cost metrics only with the cost permission). */
  async metrics({ actor }: HttpContext) {
    const cost = actor.permissions.has('analytics.cost.read')
    return {
      status: await quizMetricsStore.status(),
      metrics: METRICS.filter((m) => cost || m.source !== 'bills'),
    }
  }

  /** One metric's stored daily rows for a segment, and the segments it has. */
  async series({ request, actor }: HttpContext) {
    const q = await quizMetricSeriesValidator.validate(request.qs())
    const def = METRIC_BY_KEY.get(q.metric)!
    if (def.source === 'bills' && !actor.permissions.has('analytics.cost.read')) {
      throw new ApiException(403, 'Cost figures need the cost permission', 'FORBIDDEN')
    }
    if (q.from > q.to) throw new ApiException(422, 'from must be on or before to')
    const segment = q.segment ?? 'all'
    return {
      metric: def,
      segment,
      rows: await quizMetricsStore.series(q.metric, segment, q.from, q.to),
      segments: await quizMetricsStore.segments(q.metric, q.from, q.to),
    }
  }
}
