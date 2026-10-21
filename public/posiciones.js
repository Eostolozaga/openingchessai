/* ===========================================================================
   OpeningChessAI — las posiciones de un curso, calculadas UNA vez.

   Fase 33. Medido el 17 oct 2026 con un repertorio grande de prueba (decenas de miles
   de nodos) y un rival FIDE de 400 partidas: el analisis de
   Rival tardaba 12,9 s en un PC de escritorio —en un movil, de tres a cinco
   veces mas—. Casi todo era lo mismo repetido: tres recorridos del arbol del
   repertorio con chess.js (el cruce en espejo, la cobertura de teoria y el
   mapa por familias), cada uno moviendo pieza a pieza y pidiendo el FEN de
   cada nodo, unos 4 s cada uno. Y el repertorio NO depende del rival: era el
   mismo trabajo en cada rival que se miraba.

   Aqui se calcula el FEN de cada nodo una sola vez y se guarda en el propio
   arbol (`arbol.fen`, paralelo a `san`, `padre`, `hijos`), y los recorridos
   pasan a ser lecturas de un array. Son los MISMOS FEN que salian antes —el
   mismo camino, la misma instancia de chess.js—, asi que el resultado no
   cambia en nada; solo deja de repetirse.

   `fen[i]` es null cuando la jugada del nodo es ilegal (los recorridos ya se
   saltaban esa rama) o cuando el nodo esta por debajo de HONDO medias
   jugadas: todos los recorridos que lo usan cortan en 40.
   =========================================================================== */

import { epdDe } from './aperturas.js';

export const HONDO = 40;

/** FEN de cada nodo. Un recorrido, con move/undo y sin copiar posiciones. */
export function fenesDeArbol(Chess, arbol, hondo = HONDO) {
  const { san, hijos } = arbol;
  const fen = new Array(san.length).fill(null);
  const ch = new Chess();
  fen[0] = ch.fen();
  const bajar = (nodo, ply) => {
    if (ply >= hondo) return;
    for (const h of hijos[nodo] || []) {
      let ok = true;
      try { ch.move(san[h]); } catch { ok = false; }
      if (!ok) continue;
      fen[h] = ch.fen();
      bajar(h, ply + 1);
      ch.undo();
    }
  };
  bajar(0, 0);
  return fen;
}

/** Los FEN guardados del arbol, solo si siguen describiendo ESE arbol. Un
 *  arbol que ha ganado nodos despues de calcularlos no los usa. */
export function fenesDe(arbol) {
  const f = arbol?.fen;
  return Array.isArray(f) && f.length === arbol.san.length ? f : null;
}

/* El EPD se saca del FEN al vuelo y se recuerda por array: los tres
   recorridos lo piden para los mismos nodos. */
const EPDS = new WeakMap();
export function epdsDe(fenes) {
  if (!fenes) return null;
  let e = EPDS.get(fenes);
  if (!e) { e = fenes.map(f => (f ? epdDe(f) : null)); EPDS.set(fenes, e); }
  return e;
}
