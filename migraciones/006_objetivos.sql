-- ============================================================================
-- 006 — objetivos de entrenamiento
--   wrangler d1 execute xaketegi --file=migraciones/006_objetivos.sql --remote
--
-- Dos columnas y ni una tabla mas. Y esa es la decision de esta migracion:
--
-- LA EXPERIENCIA NO SE GUARDA. Se calcula cada vez a partir de `review_events`,
-- que ya es un log append-only de todo lo que se ha repasado nunca. Guardar un
-- contador seria crear una segunda fuente de verdad que puede desviarse de la
-- primera, y las dos formas de que se desvie ya se han visto en esta app:
--
--   · Dos moviles. El contador habria que sumarlo en los dos y resolver el
--     conflicto; el log no tiene conflictos porque la clave unica lleva el
--     instante del repaso.
--   · Repasos encolados sin cobertura. Suben horas despues, a veces al dia
--     siguiente. Un contador incrementado en el cliente contaria el dia que se
--     subio; el log guarda el `reviewed_at` de verdad.
--
-- Ademas, al derivarla, la experiencia es RETROACTIVA: todo lo repasado hasta
-- hoy cuenta desde el primer dia, en vez de empezar en cero con la funcion.
--
-- Lo unico que hay que guardar es lo que el usuario decide, que es su objetivo.
-- Cero significa «no me he puesto ninguno» y no «objetivo de cero»: sin esa
-- distincion no se puede saber si enseñar la barra o la invitacion a ponerse
-- una meta.
-- ============================================================================

ALTER TABLE users ADD COLUMN meta_diaria  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN meta_semanal INTEGER NOT NULL DEFAULT 0;

-- La consulta de progreso agrupa por dia y por curso sobre todo el historial de
-- un usuario. `ix_rev_user` es (user_id, reviewed_at) y ya sirve para el corte
-- por fecha; este otro evita recorrer el historial entero para el desglose.
CREATE INDEX IF NOT EXISTS ix_rev_curso ON review_events(user_id, curso_id);
