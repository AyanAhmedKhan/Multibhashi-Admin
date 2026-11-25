-- fact_bookings: course_bookings, the monolith's purchase record (every Razorpay flow writes
-- one; manual and B2B bookings too). paid: booking_type paid_new or paid_renewal (or, on old
-- rows without a type, a positive rate). amount: course_bookings.rate in rupees, in currency.
-- created_date: the IST date of created_at (manual bookings carry their real date there).
CREATE TABLE IF NOT EXISTS `{{project}}.{{dataset}}.fact_bookings` (
  booking_id INT64 NOT NULL,
  td_user_id INT64,
  created_at TIMESTAMP,
  created_date DATE,
  course_id INT64,
  course_type STRING,
  booking_type STRING,
  booking_status STRING,
  state STRING,
  booking_entry STRING,
  paid BOOL,
  amount NUMERIC,
  currency STRING,
  expires_at TIMESTAMP,
  utm_source STRING,
  utm_medium STRING,
  utm_campaign STRING,
  exported_at TIMESTAMP
)
PARTITION BY DATE_TRUNC(created_date, MONTH)
CLUSTER BY td_user_id
OPTIONS (description = 'Bookings (course_bookings). Nightly from MySQL.');
