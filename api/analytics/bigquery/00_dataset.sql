-- The product analytics dataset (MUL-148, design/IMPLEMENTATION-CONTRACTS.md section 5.4).
-- A new dataset in Mumbai: the project's older datasets (billing export) are in the US.
-- Applied by `node ace analytics:bq-setup --apply`; every statement is idempotent.
CREATE SCHEMA IF NOT EXISTS `{{project}}.{{dataset}}`
OPTIONS (
  location = '{{location}}',
  description = 'MultiBhashi product analytics: app events (collector), business facts and nightly models (admin console)'
);
