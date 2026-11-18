/**
 * Ordered, windowed funnel (analytics DESIGN.md §7, MUL-143).
 *
 * A learner reaches step k only after doing steps 1..k in that order, with
 * step k at most `windowMs` after the step-1 event that started the run. The
 * Insights funnel used to check only that each step happened somewhere in the
 * period, in any order: a learner who talked to the tutor on day 1 and opened
 * the app on day 20 counted as converting all the way.
 *
 * Any step-1 event can start a run, and the furthest step any run reaches is
 * what counts. One pass per learner over their events in time order: for each
 * step, keep the latest start from which steps 1..k were done in order. The
 * latest start leaves the most room in the window, so this greedy pass finds
 * the best run.
 */

export type FunnelEvent = { userId: number; type: string; at: number }
export type FunnelStep = { step: string; types: string[] }

export function orderedFunnel(events: FunnelEvent[], steps: FunnelStep[], windowMs: number) {
  const stepOf = new Map<string, number>()
  steps.forEach((s, i) => s.types.forEach((t) => stepOf.set(t, i)))

  const byUser = new Map<number, { step: number; at: number }[]>()
  for (const e of events) {
    const step = stepOf.get(e.type)
    const at = Number(e.at)
    if (step === undefined || !Number.isFinite(at)) continue
    let list = byUser.get(e.userId)
    if (!list) byUser.set(e.userId, (list = []))
    list.push({ step, at })
  }

  const reached = new Array<number>(steps.length).fill(0)
  for (const list of byUser.values()) {
    // Same instant: the earlier step first, so it can lead into the later one.
    list.sort((a, b) => a.at - b.at || a.step - b.step)
    const start = new Array<number | null>(steps.length).fill(null)
    let furthest = -1
    for (const { step, at } of list) {
      if (step === 0) {
        start[0] = at
      } else {
        const from = start[step - 1]
        if (from === null || at - from > windowMs) continue
        if (start[step] === null || from > start[step]!) start[step] = from
      }
      if (step > furthest) furthest = step
    }
    for (let k = 0; k <= furthest; k++) reached[k]++
  }

  return steps.map((s, i) => ({ step: s.step, users: reached[i] }))
}
