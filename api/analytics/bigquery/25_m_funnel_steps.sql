-- m_funnel_steps: the five funnels of DESIGN section 7, ordered and windowed. One row per
-- funnel, run start day (IST) and person (and run_scope, e.g. the class type for the live
-- class funnel): the furthest step reached by a run starting that day. Same semantics as the
-- console's funnel.ts: a step counts only after the step before it, within the funnel's window
-- of the start; the latest start is kept. Over a date range, a person counts at their
-- furthest run.
-- step_at: when each reached step was first reached (one timestamp per reached step).
-- step_gap_s: for steps 2..n, seconds from the latest previous step to the event that reached
-- the step (the time between steps; repeated earlier steps don't inflate it).
-- Person-level, so partitions expire after 395 days.
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.m_funnel_steps` (
  funnel STRING,
  start_date DATE,
  person STRING,
  user_id STRING,
  run_scope STRING,
  steps_reached INT64,
  step_at ARRAY<TIMESTAMP>,
  step_gap_s ARRAY<INT64>,
  platform STRING,
  channel STRING,
  app_version STRING,
  modelled_at TIMESTAMP
)
PARTITION BY start_date
CLUSTER BY funnel, person
OPTIONS (
  partition_expiration_days = 395,
  description = 'Ordered, windowed funnel runs per person and start day (model).'
);
