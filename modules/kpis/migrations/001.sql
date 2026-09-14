CREATE TABLE IF NOT EXISTS daily (
  id SERIAL PRIMARY KEY,
  day DATE NOT NULL,
  weekday INTEGER NOT NULL,
  demand INTEGER NOT NULL,
  customer_orders INTEGER NOT NULL,
  production_orders INTEGER NOT NULL,
  produced INTEGER NOT NULL,
  shipped INTEGER NOT NULL,
  purchases INTEGER NOT NULL,
  wip_total INTEGER NOT NULL,
  finished_goods INTEGER NOT NULL,
  backlog INTEGER NOT NULL,
  defects INTEGER NOT NULL,
  changeovers INTEGER NOT NULL,
  overtime_hours NUMERIC(5,1) NOT NULL,
  lead_time_days NUMERIC(5,2) NOT NULL,
  on_time_pct NUMERIC(5,1) NOT NULL,
  people INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS daily_day_idx ON daily (day);

CREATE TABLE IF NOT EXISTS station_daily (
  id SERIAL PRIMARY KEY,
  day DATE NOT NULL,
  seq INTEGER NOT NULL,
  station TEXT NOT NULL,
  wip INTEGER NOT NULL,
  output INTEGER NOT NULL,
  defects INTEGER NOT NULL,
  seconds_per_unit NUMERIC(6,1) NOT NULL
);

CREATE INDEX IF NOT EXISTS station_daily_day_idx ON station_daily (day);

CREATE TABLE IF NOT EXISTS defect_daily (
  id SERIAL PRIMARY KEY,
  day DATE NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_daily (
  id SERIAL PRIMARY KEY,
  day DATE NOT NULL,
  item TEXT NOT NULL,
  on_hand INTEGER NOT NULL,
  received INTEGER NOT NULL,
  stockout INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chats (
  id SERIAL PRIMARY KEY,
  title TEXT,
  model TEXT,
  messages JSONB NOT NULL,
  cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
