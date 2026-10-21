-- ============================================================================
-- 002 — identidad del usuario
--   wrangler d1 execute xaketegi --file=migraciones/002_identidad.sql --remote
--
-- Anade a `users` lo que hace falta para resolver QUIEN es el usuario en el
-- mundo FIDE, que es distinto de quien es en Lichess.
--
-- `fide_origen` es la columna importante y merece explicacion:
--   'lichess'   -> el numero lo devolvio la API de Lichess porque el usuario
--                  tiene su ficha FIDE vinculada alli. Lo respalda un tercero.
--   'declarado' -> lo tecleo o lo eligio el propio usuario. Vale para sus
--                  funciones personales, pero NO basta para promocionar sus
--                  partidas cedidas a la base compartida.
--   NULL        -> todavia no lo sabemos.
--
-- Sin esta distincion, cualquiera podria reclamar la ficha de un GM y ensuciar
-- la base con partidas atribuidas a quien no es. Guardar solo el numero
-- perderia justo el dato que permite decidir de quien fiarse.
--
-- Los otros cuatro campos (nombre real, federacion, titulo y elo FIDE) no son
-- decorativos: son lo que reduce el censo FIDE de 1,9 millones de fichas a una
-- lista corta cuando hay que preguntarle al usuario cual es la suya. Nadie se
-- sabe su ID FIDE de memoria; su nombre y su pais si.
--
-- D1 no tiene "ADD COLUMN IF NOT EXISTS": si esta migracion ya se aplico, los
-- ALTER fallaran con "duplicate column name" y no pasa nada. Es reejecutable
-- en el sentido de que no corrompe, no en el de que no proteste.
-- ============================================================================

ALTER TABLE users ADD COLUMN fide_origen TEXT;   -- 'lichess' | 'declarado' | NULL
ALTER TABLE users ADD COLUMN nombre      TEXT;   -- realName del perfil de Lichess
ALTER TABLE users ADD COLUMN pais        TEXT;   -- codigo de federacion, p.ej. ES
ALTER TABLE users ADD COLUMN titulo      TEXT;   -- GM, IM, FM...
ALTER TABLE users ADD COLUMN elo_fide    INTEGER;

-- Las fichas ya existentes se marcan como declaradas: entraron por el formulario
-- del enlace magico, que es exactamente eso.
UPDATE users SET fide_origen = 'declarado'
 WHERE fide_id IS NOT NULL AND fide_id <> '' AND fide_origen IS NULL;
