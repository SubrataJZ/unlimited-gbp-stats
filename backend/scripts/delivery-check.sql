-- delivery-check.sql — READ ONLY. Run before handing any report to a customer.
--   docker exec -i gbp_postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -At' < backend/scripts/delivery-check.sql
-- Prints nothing when the data is clean. Each section is a problem to fix first.

-- 1. One business stored under two entries. Same org, same metric and month,
--    same non-zero total on most shared months (the thresholds the extension uses).
with pairs as (
  select a.id as a_id, b.id as b_id, a.name as a_name, b.name as b_name,
         count(*) filter (where ma.total > 0 and mb.total > 0) as overlap,
         count(*) filter (where ma.total > 0 and ma.total = mb.total) as same
  from tracked_businesses a
  join tracked_businesses b on b.org_id = a.org_id and b.id > a.id
  join metric_months ma on ma.tracked_business_id = a.id
  join metric_months mb on mb.tracked_business_id = b.id
       and mb.metric_type = ma.metric_type and mb.year = ma.year and mb.month = ma.month
  group by a.id, b.id, a.name, b.name)
select 'DUPLICATE: ' || a_name || ' <-> ' || b_name || ' (same=' || same || ', overlap=' || overlap || ')' as problem
from pairs where same >= 12 and same::float / overlap >= 0.6;

-- 2. A month far below both neighbours: a capture taken before the month ended.
with s as (
  select t.name, m.metric_type, m.year, m.month, m.total,
         lag(m.total) over w as prev_total, lead(m.total) over w as next_total
  from metric_months m join tracked_businesses t on t.id = m.tracked_business_id
  where not m.is_derived
  window w as (partition by m.tracked_business_id, m.metric_type order by m.year, m.month))
select 'PARTIAL MONTH: ' || name || ' ' || metric_type || ' ' || year || '-' || lpad(month::text, 2, '0')
       || ' = ' || total || ' (neighbours ' || prev_total || ', ' || next_total || ')'
from s where prev_total > 0 and next_total > 0 and total < 0.25 * least(prev_total, next_total);

-- 3. A business with no real name left (empty, a question, or a rating).
select 'BAD NAME: ' || coalesce(name, '<null>') || ' (' || google_place_id || ')'
from tracked_businesses
where name is null or name = '' or name like '%?' or name ~ '^[0-9.() ]+$';
