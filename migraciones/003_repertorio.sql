-- ============================================================================
-- 003 — repertorio de verdad
--   wrangler d1 execute xaketegi --file=migraciones/003_repertorio.sql --remote
--
-- El modelo anterior era una lista de codigos ECO. No servia para nada de lo
-- que la app tiene que hacer: contra un ECO no se puede entrenar, no se puede
-- cruzar un rival y no se puede buscar una novedad, porque un ECO no contiene
-- jugadas. B12 son la Caro-Kann del avance, la del cambio y media docena mas.
--
-- El modelo nuevo son dos cosas:
--   1. Cursos marcados como repertorio. El arbol del PGN YA tiene las jugadas,
--      asi que marcar un curso es la forma mas barata de tener repertorio.
--   2. Lineas sueltas, para cubrir lo que uno juega y no tiene en ningun PGN.
--
-- La tabla vieja no se borra, se renombra. Perder datos de alguien por una
-- decision de diseno nuestra no esta bien aunque sean cuatro codigos.
-- ============================================================================

ALTER TABLE cursos ADD COLUMN en_repertorio INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS lineas (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  color      TEXT NOT NULL CHECK (color IN ('white','black')),
  nombre     TEXT,
  eco        TEXT,
  -- Los SAN separados por espacios, no UCI ni FEN: es lo que se lee de un
  -- vistazo al depurar y lo que se puede reproducir con cualquier libreria.
  -- La posicion se deriva jugandolos; guardarla ademas seria duplicar estado
  -- que puede quedar incoherente.
  jugadas    TEXT NOT NULL,
  creado_en  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lineas_user ON lineas(user_id, color);

ALTER TABLE repertorio RENAME TO repertorio_eco_obsoleto;
