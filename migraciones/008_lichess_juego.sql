-- ===========================================================================
-- 008 — Usuario de Lichess DECLARADO, para la pestaña Análisis.
--
-- Quien entra por email no tiene `lichess` (esa columna la rellena el login
-- OAuth y es UNIQUE: es identidad). Para bajar sus partidas basta con el
-- nombre, y declararlo no autoriza nada, así que va en columna aparte.
--
--   npx wrangler d1 execute xaketegi --file=migraciones/008_lichess_juego.sql --remote
-- ===========================================================================

ALTER TABLE users ADD COLUMN lichess_juego TEXT;
