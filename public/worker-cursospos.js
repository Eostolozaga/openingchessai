/* ===========================================================================
   OpeningChessAI — qué cursos TUYOS pasan por cada posición.

   Los cursos del usuario ya están parseados en el móvil (el árbol vive en IndexedDB desde
   que se abre el curso por primera vez), así que el mapa se construye aquí y
   no cuesta ni una petición.

   SE INDEXA POR POSICIÓN, no por camino: así una Catalana a la que se llega
   por 1.d4 Cf6 2.c4 e6 3.g3 se reconoce igual que por 1.Cf3 d5 2.g3 — que es
   justo lo que uno quiere al mover piezas en el tablero.

   Se hace una vez por sesión y se guarda en memoria del hilo principal.
   =========================================================================== */

import { Chess } from './vendor/chess.js';
import { epdDe } from './aperturas.js';

/* Veinte jugadas de cada curso. Más allá ya no es preparación de apertura, y
   un curso con miles de partidas largas llenaría el mapa de finales. */
const PLY_MAX = 40;
/* Techo por curso, como en los demás recorridos: un PGN patológico no puede
   dejar la pantalla colgada ni comerse la memoria del móvil. */
const MAX_NODOS = 250000;

self.onmessage = (e) => {
  try {
    postMessage({ ok: true, ...indexar(e.data.fuentes || []) });
  } catch (err) {
    postMessage({ ok: false, error: String(err?.message || err) });
  }
};

function indexar(fuentes) {
  const ch = new Chess();
  // epd -> ids de curso. Objeto normal: viaja por structuredClone y se
  // consulta por clave; un Map cuesta más de serializar y no aporta nada.
  const mapa = Object.create(null);
  const recortados = [];
  let posiciones = 0;

  const anotar = (id) => {
    const epd = epdDe(ch.fen());
    const ya = mapa[epd];
    if (!ya) { mapa[epd] = [id]; posiciones++; return; }
    if (ya[ya.length - 1] !== id) ya.push(id);
  };

  for (const f of fuentes) {
    ch.reset();
    let vistos = 0;

    if (f.arbol) {
      const { san, hijos } = f.arbol;
      const bajar = (nodo, ply) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        anotar(f.id);
        for (const h of hijos[nodo] || []) {
          vistos++;
          if (vistos > MAX_NODOS) break;
          let ok = true;
          try { ch.move(san[h]); } catch { ok = false; }
          if (!ok) continue;
          bajar(h, ply + 1);
          ch.undo();
        }
      };
      bajar(0, 0);
    } else if (f.jugadas) {
      const sanes = String(f.jugadas).split(' ').filter(Boolean).slice(0, PLY_MAX);
      for (let i = 0; i <= sanes.length; i++) {
        anotar(f.id);
        if (i === sanes.length) break;
        try { if (!ch.move(sanes[i])) break; } catch { break; }
      }
    }
    if (vistos > MAX_NODOS) recortados.push(f.nombre || f.id);
  }

  return { mapa, posiciones, recortados };
}
