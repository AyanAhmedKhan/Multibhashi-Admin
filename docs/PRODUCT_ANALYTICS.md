# Product analytics in the console (MUL-125)

The console side of product analytics: the BigQuery warehouse, the nightly business facts and
SQL models, the Insights pages that read them, the weekly digest, deletion and the
consolidation with the older activity pipeline.

The design is `design/product-analytics/DESIGN.md`, and the binding contracts are in
`design/IMPLEMENTATION-CONTRACTS.md` §0 and §5. The app SDK and the collector (`/e`, a Vercel
Function that writes `events_raw`) are built in the learner app repo.

```
app (web, Android, iOS) ── POST /e ──► collector ── insertAll ──► events_raw / events_dev
                                                                         │
MySQL read replica ── analytics:export-facts ──► fact_* , identities     │
                                                         │               │
                              analytics:models ◄─────────┴───────────────┘
                                     │
                                     ▼
                          m_* model tables ──► Insights (product tabs), weekly digest
```

## 1. Warehouse (MUL-148)

**Dataset.** `product_analytics` in **asia-south1**, in the GCP project named by
`GCP_ANALYTICS_PROJECT`. The DDL is plain SQL in `api/analytics/bigquery/`, applied in file
order. Every statement is idempotent.

| Table | What | Partition / cluster | Retention |
|---|---|---|---|
| `events_raw` | every accepted event (contract §5.4), written by the collector | `event_date` / `event_name, user_id` | 395 days |
| `events_dev` | the same schema, for debug and staging streams | `event_date` / `event_name, user_id` | 30 days |
| `fact_*`, `identities` | business facts from MySQL (§2) | month of the fact date / `td_user_id` | kept |
| `m_sessions`, `m_funnel_steps` | person-level models (§3) | day | 395 days |
| other `m_*` | aggregates (§3) | day or none | kept |

`analytics:bq-setup` also runs `ALTER TABLE … SET OPTIONS (partition_expiration_days = …)` on
both event tables. The retention then holds even if the collector created a table first.

```bash
node ace analytics:bq-setup              # prints the plan and the SQL; changes nothing
node ace analytics:bq-setup --plan-only  # the plan only
node ace analytics:bq-setup --apply      # creates or updates the objects
```

**Settings.** These are in `.env.example` and `deploy/.env.production.example`. All are
optional; without them the product tabs say "Product analytics isn't connected yet".

| Variable | Meaning |
|---|---|
| `GCP_ANALYTICS_PROJECT` | the GCP project that holds the dataset and runs the console's jobs |
| `GCP_ANALYTICS_DATASET` | default `product_analytics` |
| `GCP_ANALYTICS_CREDENTIALS_JSON` or `GCP_ANALYTICS_CREDENTIALS_FILE` | the console's service-account key: the JSON (raw or base64), or a path to the key file |

**One-time steps outside the repo.**
1. Pick the project: the one with the billing export, or a new one (decision MUL-142).
2. Create two service accounts:
   - **collector writer**, used by the Vercel Function (`GCP_ANALYTICS_SA_KEY` there): *BigQuery Data Editor* on the dataset only. It needs `insertAll` and no jobs.
   - **console**, used by this API: *BigQuery Data Editor* on the dataset and *BigQuery Job User* on the project. It loads the facts, runs the models and deletes on request.

   *BigQuery Data Editor* is granted on the dataset, which exists only after the first `--apply`. For that first run, grant the console account *BigQuery Data Editor* on the project temporarily (it needs `bigquery.datasets.create`), or have an owner create the dataset first.
3. Run `analytics:bq-setup --apply` once, then after any deploy that changes `api/analytics/bigquery/`.
4. Add a budget alert on the project, scoped to BigQuery (MUL-148).
