/* ===========================================================================
   OpeningChessAI — el explorador de partidas de maestros.

   HASTA MARZO DE 2026 ESTO LLAMABA A LICHESS DIRECTAMENTE DESDE EL NAVEGADOR,
   y el comentario que lo justificaba estaba bien: el limite de peticiones de
   Lichess era por IP, asi que desde el navegador cada usuario gastaba su propia
   cuota mientras que a traves del Worker todos habrian compartido la del edge
   de Cloudflare.

   El 3 de marzo de 2026 Lichess cerro el explorador a las peticiones anonimas.
   Devuelve 401 a quien no manda un token, y ese fue el error que aparecia al
   pulsar «Ver que se juega aqui». Con el cierre, el argumento de arriba se da
   la vuelta: el limite ya no va por IP sino por token, el token no debe salir
   del servidor, y de paso el Worker puede cachear la respuesta en el edge —una
   posicion de apertura la miran todos los usuarios y el reparto es el mismo
   para todos—.

   Asi que ahora se pide a /api/explorer y el Worker pone el token. Aqui solo
   queda el cache en memoria, que sigue haciendo falta: al navegar un arbol se
   vuelve una y otra vez a las mismas posiciones, y sin el cada paso atras seria
   otro viaje de ida y vuelta.
   =========================================================================== */

import { epdDe } from './aperturas.js';
import { api } from './comun.js';

const CACHE = new Map();
const MAX = 300;   // suficiente para una sesion de estudio; no crece sin fin

const claveDe = (fen, jugadas, top) => `${epdDe(fen)}|${jugadas}|${top}`;

export async function maestros(fen, { jugadas = 10, top = 0 } = {}) {
  const clave = claveDe(fen, jugadas, top);
  if (CACHE.has(clave)) return CACHE.get(clave);

  const d = await api(
    `explorer?fen=${encodeURIComponent(fen)}&moves=${jugadas}&top=${top}`);

  if (CACHE.size >= MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(clave, d);
  return d;
}

/**
 * Lo que ya esta en el cache, sin esperar.
 *
 * Lo necesita el explorador: las flechas del tablero se pintan de forma
 * sincrona y tienen que saber ya si hay continuacion. Devolver una promesa
 * obligaria a pintar los botones dos veces en cada jugada, y el parpadeo se ve.
 */
export function maestrosEnCache(fen, { jugadas = 10, top = 0 } = {}) {
  return CACHE.get(claveDe(fen, jugadas, top)) || null;
}

/** Una partida modelo entera, por su identificador de Lichess. */
export function partidaMaestros(id) {
  return api('partida/' + encodeURIComponent(id));
}

/** Partidas totales de una posicion o de una jugada. */
export const total = (x) => (x.white || 0) + (x.draws || 0) + (x.black || 0);

/**
 * Resultado desde el punto de vista de un color, en porcentaje.
 * Las tablas cuentan medio punto, como en la tabla de clasificacion: un 50 %
 * con muchas tablas y un 50 % con victorias y derrotas repartidas valen lo
 * mismo para quien elige que jugar.
 */
export function score(x, color) {
  const n = total(x);
  if (!n) return null;
  const propias = color === 'white' ? x.white : x.black;
  return ((propias + x.draws / 2) / n) * 100;
}
