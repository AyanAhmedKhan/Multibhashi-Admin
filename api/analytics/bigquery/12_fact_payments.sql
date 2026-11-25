-- fact_payments: transactions, written by the monolith only after Razorpay reports the payment
-- captured (payment_status 'success'). amount is in rupees; the currency comes from the
-- booking. captured_at: the earlier of the transaction and its booking (the monolith inserts
-- the booking first, then the transaction, both after the capture), so the purchase funnel
-- sees payment then booking. gateway_verified: a real Razorpay payment id (pay_ + 14
-- characters); manual and imported bookings carry a made-up one. gateway_ref_hash: a hash of
-- that id, to spot the duplicate rows a retried request can insert. The id itself is not kept.
-- created_date: the IST date of the transaction row (the export's date filter).
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.fact_payments` (
  payment_id INT64 NOT NULL,
  td_user_id INT64,
  course_booking_id INT64,
  created_at TIMESTAMP,
  captured_at TIMESTAMP,
  created_date DATE,
  amount NUMERIC,
  currency STRING,
  status STRING,
  captured BOOL,
  method STRING,
  gateway_verified BOOL,
  gateway_ref_hash STRING,
  exported_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(created_date, MONTH)
CLUSTER BY td_user_id
OPTIONS (description = 'Captured payments (transactions). Nightly from MySQL.');
