-- ============================================================================
-- OpeningChessAI — esquema D1
--   wrangler d1 execute xaketegi --file=schema.sql --remote
-- Idempotente: se puede reejecutar sin perder datos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- CUENTAS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,              -- uuid
  email        TEXT UNIQUE,                   -- puede ser NULL si entro por Lichess
  lichess      TEXT UNIQUE,                   -- usuario de Lichess
  fide_id      TEXT,                          -- opcional, se pide al subir partidas
  -- De donde sale el fide_id: 'lichess' (lo confirma un tercero) o 'declarado'
  -- (lo dijo el usuario). Solo el primero basta para promocionar sus partidas
  -- cedidas sin revision. Ver migraciones/002_identidad.sql.
  fide_origen  TEXT,
  -- Material para preguntar bien cuando no hay fide_id: con nombre, pais,
  -- titulo y elo, el censo FIDE de 1,9 M de fichas se reduce a una lista corta.
  nombre       TEXT,
  pais         TEXT,
  titulo       TEXT,
  elo_fide     INTEGER,
  creado_en    TEXT NOT NULL,
  visto_en     TEXT,
  -- Consentimiento de cesion. Se guarda CUANDO se dio, no solo que se dio:
  -- si algun dia hay que acreditarlo, "true" a secas no vale de nada.
  cede_partidas    INTEGER NOT NULL DEFAULT 0,
  cede_actualizado TEXT,
  -- Objetivos de entrenamiento que se pone el propio usuario, en repasos.
  -- Cero es «no me he puesto ninguno», no «objetivo de cero». La experiencia
  -- NO se guarda: se deriva de review_events. Ver migraciones/006_objetivos.sql.
  meta_diaria  INTEGER NOT NULL DEFAULT 0,
  meta_semanal INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_users_fide ON users(fide_id) WHERE fide_id IS NOT NULL;

-- Enlaces magicos de un solo uso. El token viaja firmado; aqui solo vive su
-- jti, que se borra al canjearlo. Sin esta tabla el enlace seria reutilizable
-- hasta que caducara, y los enlaces de correo se reenvian y se filtran.
CREATE TABLE IF NOT EXISTS magic_tokens (
  jti        TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  fide_id    TEXT,
  expira_en  INTEGER NOT NULL                 -- epoch segundos
);
CREATE INDEX IF NOT EXISTS ix_magic_exp ON magic_tokens(expira_en);

-- ---------------------------------------------------------------------------
-- CURSOS (los PGN que sube el usuario). El fichero vive en R2; aqui la ficha.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cursos (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nombre     TEXT NOT NULL,
  color      TEXT NOT NULL CHECK (color IN ('white','black')),
  r2_key     TEXT NOT NULL,                   -- privado/<user_id>/<id>.pgn
  bytes      INTEGER NOT NULL DEFAULT 0,
  n_partidas INTEGER NOT NULL DEFAULT 0,
  -- Marcado como parte del repertorio: su arbol es lo que se entrena y lo que
  -- se cruza contra las partidas del rival.
  en_repertorio INTEGER NOT NULL DEFAULT 0,
  subido_en  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cursos_user ON cursos(user_id);

-- ---------------------------------------------------------------------------
-- REPERTORIO
-- ---------------------------------------------------------------------------
-- El repertorio son dos cosas: los cursos marcados como tales (su arbol ya
-- tiene las jugadas) y las lineas sueltas que uno mete a mano para cubrir lo
-- que no tiene en ningun PGN. Ver migraciones/003_repertorio.sql.
CREATE TABLE IF NOT EXISTS lineas (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  color      TEXT NOT NULL CHECK (color IN ('white','black')),
  nombre     TEXT,
  eco        TEXT,
  jugadas    TEXT NOT NULL,          -- SAN separados por espacios
  creado_en  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lineas_user ON lineas(user_id, color);

-- ---------------------------------------------------------------------------
-- ENTRENAMIENTO
-- ---------------------------------------------------------------------------
-- Log append-only. Es la fuente de verdad de la sincronizacion: el movil
-- encola eventos sin red y los sube cuando puede, y como la clave unica
-- incluye el instante del repaso, reenviar el mismo lote no duplica nada.
-- Sin esto habria que resolver conflictos entre dispositivos a mano.
CREATE TABLE IF NOT EXISTS review_events (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL,                  -- sha1(epd|san|color)
  epd         TEXT NOT NULL,
  san         TEXT NOT NULL,
  color       TEXT NOT NULL,
  curso_id    TEXT,
  acierto     INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL,                  -- ISO, lo pone el cliente
  PRIMARY KEY (user_id, card_id, reviewed_at)
);
CREATE INDEX IF NOT EXISTS ix_rev_user ON review_events(user_id, reviewed_at);
CREATE INDEX IF NOT EXISTS ix_rev_curso ON review_events(user_id, curso_id);

-- Estado FSRS derivado. Es cache: si se corrompe, se reconstruye reproduciendo
-- review_events. Por eso las escrituras aqui nunca son criticas.
CREATE TABLE IF NOT EXISTS flashcards (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL,
  epd         TEXT NOT NULL,
  san         TEXT NOT NULL,
  color       TEXT NOT NULL,
  curso_id    TEXT,
  stability   REAL NOT NULL DEFAULT 0,
  difficulty  REAL NOT NULL DEFAULT 5,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  last_seen   TEXT,
  next_due    TEXT,
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX IF NOT EXISTS ix_fc_due ON flashcards(user_id, next_due);

-- ---------------------------------------------------------------------------
-- PARTIDAS CEDIDAS
-- ---------------------------------------------------------------------------
-- Staging, NO la base final. Dos razones:
--   1. Sin los dos FIDE ID resueltos, promocionar mete ruido irreversible en
--      millones de partidas.
--   2. Si alguien ejerce su derecho de supresion, hay que poder localizar y
--      borrar lo suyo. Fusionado en rivals.db ya no se puede.
CREATE TABLE IF NOT EXISTS submitted_games (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_hash   TEXT NOT NULL,                  -- sha1(jugadas|resultado|fecha)
  pgn         TEXT NOT NULL,
  white       TEXT, black TEXT,
  white_fide  TEXT, black_fide TEXT,
  event       TEXT, played_at TEXT, result TEXT,
  estado      TEXT NOT NULL DEFAULT 'pendiente'
              CHECK (estado IN ('pendiente','resuelta','ambigua','descartada')),
  cedido_en   TEXT NOT NULL
);
-- La misma partida subida por sus dos jugadores no es un problema: es
-- confirmacion cruzada, cada uno aporta su identidad verificada de un lado.
-- Por eso el UNIQUE es (user_id, game_hash) y no solo game_hash.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_user_hash ON submitted_games(user_id, game_hash);
CREATE INDEX IF NOT EXISTS ix_sub_estado ON submitted_games(estado);
CREATE INDEX IF NOT EXISTS ix_sub_hash   ON submitted_games(game_hash);
