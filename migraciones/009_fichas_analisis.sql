-- ===========================================================================
-- 009 — Fichas de fallos de la pestaña Análisis (Fase 27, C).
--
-- Tabla PROPIA y no `flashcards`: aquellas salen de tus cursos y se derivan de
-- review_events (se pueden reconstruir); estas salen de tus partidas y la
-- respuesta buena la puso el motor. Mezclarlas contaminaría la XP y el
-- repaso de los cursos, y el usuario las quiere separadas.
--
-- El repaso es SM-2 sencillo guardado en la propia fila: no hay nada que
-- reconstruir, así que no hace falta tabla de eventos.
--
--   npx wrangler d1 execute xaketegi --file=migraciones/009_fichas_analisis.sql --remote
-- ===========================================================================

CREATE TABLE IF NOT EXISTS fichas_analisis (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,              -- epd|jugada fallada
  fen        TEXT NOT NULL,
  mejor      TEXT NOT NULL,              -- SAN que da el motor
  jugada     TEXT NOT NULL,              -- SAN que jugaste
  color      TEXT NOT NULL,              -- 'white' | 'black'
  fase       TEXT,
  apertura   TEXT,
  linea      TEXT,                       -- jugadas hasta la posición, en SAN
  veces      INTEGER NOT NULL DEFAULT 1, -- en cuántas partidas lo fallaste
  intervalo  REAL NOT NULL DEFAULT 0,    -- días
  facilidad  REAL NOT NULL DEFAULT 2.5,
  reps       INTEGER NOT NULL DEFAULT 0,
  fallos     INTEGER NOT NULL DEFAULT 0,
  proxima    TEXT NOT NULL,
  creada     TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS ix_fa_proxima ON fichas_analisis(user_id, proxima);
