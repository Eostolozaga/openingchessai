-- ============================================================================
-- 005 — la puerta
--   wrangler d1 execute xaketegi --file=migraciones/005_acceso.sql --remote
--
-- Hasta ahora la app estaba abierta: cualquiera con una cuenta de Lichess o un
-- correo entraba y subia sus PGN. Eso no es solo una cuestion de quien entra,
-- es tambien coste en D1 y en R2 de quien no conoces.
--
-- A partir de aqui hay tres estados:
--
--   'pendiente'  se ha registrado y no ve nada. Es el estado por defecto.
--   'activo'     aprobado. Y lo sigue siendo PARA SIEMPRE: no caduca, no hay
--                que renovarlo, no se revisa. Solo el administrador puede
--                quitarlo.
--   'bloqueado'  se le ha retirado el acceso. Su cuenta y sus datos siguen
--                donde estaban; simplemente no entra. Es reversible, y es lo
--                que hay que usar en vez de borrar a alguien por si acaso.
--
-- Los que ya estaban se quedan ACTIVOS. Cerrar la puerta a la gente que ya
-- estaba dentro no es cerrar la puerta, es echarla.
--
-- `invitados` es la lista de preautorizados. Sirve para que quien tu ya conoces
-- no espere ni un segundo: apuntas su correo o su usuario de Lichess ANTES de
-- que se registre y entra directo, sin pasar por pendiente. Se consume al
-- usarse, para que la lista no crezca con gente que ya esta dentro.
--
-- D1 no tiene "ADD COLUMN IF NOT EXISTS": si esta migracion ya se aplico, los
-- ALTER fallaran con "duplicate column name" y no pasa nada.
-- ============================================================================

ALTER TABLE users ADD COLUMN estado       TEXT;   -- pendiente | activo | bloqueado
ALTER TABLE users ADD COLUMN aprobado_en  TEXT;
ALTER TABLE users ADD COLUMN nota_admin   TEXT;   -- para acordarse de quien es

-- Los que ya existen entraron cuando la puerta estaba abierta: se quedan.
UPDATE users SET estado = 'activo', aprobado_en = creado_en WHERE estado IS NULL;

CREATE TABLE IF NOT EXISTS invitados (
  id          TEXT PRIMARY KEY,
  -- Uno de los dos, no los dos: se invita por lo que sepas de esa persona.
  email       TEXT,
  lichess     TEXT,
  nota        TEXT,
  creado_en   TEXT NOT NULL,
  usado_en    TEXT,          -- cuando se registro con el, si se registro
  usado_por   TEXT           -- id del usuario que lo consumio
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_invitados_email   ON invitados(email)   WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_invitados_lichess ON invitados(lichess) WHERE lichess IS NOT NULL;

-- Una ficha FIDE confirmada por Lichess identifica a una persona, y una persona
-- no tiene dos cuentas. El indice es PARCIAL a proposito: solo sobre las
-- confirmadas. Sobre las declaradas seria un arma —cualquiera podria dejar
-- fuera al dueno legitimo tecleando su numero antes que el— y ahi lo que
-- corresponde es avisar al administrador, no bloquear.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_fide_confirmado
  ON users(fide_id) WHERE fide_id IS NOT NULL AND fide_origen = 'lichess';

CREATE INDEX IF NOT EXISTS ix_users_estado ON users(estado);

-- ============================================================================
-- Contadores de envio de correo
--
-- El plan gratuito de Resend son 100 correos al dia y 3.000 al mes. Pasarse no
-- da un aviso: da un rechazo, y el usuario ve un fallo sin entender por que.
-- Mejor contarlos aqui y decirlo antes de intentarlo.
--
-- Hay TRES limites y el tercero es el que de verdad protege:
--
--   dia   100    el de Resend
--   mes  3000    el de Resend
--   por correo y dia, 5   el que impide que una sola persona —o un script
--                         aburrido— se coma la cuota de todos en dos minutos
--
-- Una tabla de contadores con clave de texto en vez de una columna por limite:
-- asi anadir un limite nuevo manana no es otra migracion.
-- ============================================================================
CREATE TABLE IF NOT EXISTS contadores (
  clave          TEXT PRIMARY KEY,
  n              INTEGER NOT NULL DEFAULT 0,
  actualizado_en TEXT NOT NULL
);
