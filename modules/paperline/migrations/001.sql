CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  instruction_dart TEXT NOT NULL,
  instruction_glider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  number INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  released INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  scrapped INTEGER NOT NULL DEFAULT 0,
  avg_distance NUMERIC(6,1),
  stockouts INTEGER NOT NULL DEFAULT 0,
  wip_end INTEGER NOT NULL DEFAULT 0,
  summary JSONB
);

CREATE TABLE IF NOT EXISTS travelers (
  id SERIAL PRIMARY KEY,
  job_num TEXT NOT NULL,
  shift_id INTEGER,
  color TEXT NOT NULL,
  fold_type TEXT NOT NULL,
  clip_pos TEXT NOT NULL,
  station_id INTEGER,
  state TEXT NOT NULL DEFAULT 'queued',
  released_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  arrived_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  done_shift_id INTEGER,
  distance_ft NUMERIC(6,1),
  qc TEXT
);

CREATE INDEX IF NOT EXISTS travelers_station_idx ON travelers (station_id);

CREATE TABLE IF NOT EXISTS traveler_log (
  id SERIAL PRIMARY KEY,
  traveler_id INTEGER NOT NULL,
  station_id INTEGER,
  shift_id INTEGER,
  event TEXT NOT NULL,
  operator TEXT,
  seconds INTEGER,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS traveler_log_traveler_idx ON traveler_log (traveler_id);

CREATE TABLE IF NOT EXISTS inventory (
  id SERIAL PRIMARY KEY,
  item TEXT NOT NULL,
  location TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS material_requests (
  id SERIAL PRIMARY KEY,
  station_id INTEGER,
  item TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO stations (seq, name, instruction_dart, instruction_glider) VALUES
  (1, 'Kit and Crease',
   'Take one sheet of the color on the traveler. Fold it in half the long way, crease hard, then unfold it.',
   'Take one sheet of the color on the traveler. Fold it in half the long way, crease hard, then unfold it.'),
  (2, 'Nose Folds',
   'Fold the two top corners in to the center crease so the top comes to a point.',
   'Fold the two top corners in to the center crease so the top comes to a point.'),
  (3, 'Body Fold',
   'Fold the two new slanted edges in to the center crease again. You get a long narrow point.',
   'Fold the pointed top down toward you so the tip lands about 2 inches above the bottom edge. Crease it flat.'),
  (4, 'Wings',
   'Fold the plane in half along the center crease with the point on the outside. Fold each wing down so its edge lines up with the bottom edge.',
   'Fold the plane in half along the center crease. Fold each wing down leaving about half an inch of body below the wing. Wide wings.'),
  (5, 'Clip and Test',
   'Put the paper clip where the traveler says. Throw it once from the line. Enter the distance and pass or scrap it.',
   'Put the paper clip where the traveler says. Throw it once from the line. Enter the distance and pass or scrap it.');

INSERT INTO inventory (item, location, qty) VALUES
  ('paper_white', 'line', 4), ('paper_blue', 'line', 1), ('paper_yellow', 'line', 2), ('clip', 'line', 3),
  ('paper_white', 'stock', 60), ('paper_blue', 'stock', 40), ('paper_yellow', 'stock', 40), ('clip', 'stock', 50);

INSERT INTO settings (key, value) VALUES ('shift_seconds', '120'), ('release_per_shift', '10');
