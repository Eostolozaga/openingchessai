/* ===========================================================================
   OpeningChessAI — de que apertura es cada ficha.

   EL PROBLEMA. Una ficha guarda una posicion (su EPD) y la jugada buena, y
   nada mas. No guarda el camino. Y buscar esa posicion en la tabla de
   aperturas casi nunca funciona: la tabla nombra las posiciones CARACTERISTICAS
   de cada apertura —unas tres mil— y una ficha suele estar dos o tres jugadas
   mas alla, en una posicion que no tiene nombre propio. Preguntando asi, nueve
   de cada diez fichas salen «sin clasificar», que es una pestaña de filtros
   inutil.

   LA SOLUCION. Las fichas salen de tus cursos, y tus cursos SI tienen el camino
   entero. Se recorre el arbol de cada curso llevando a cuestas el ultimo nombre
   de apertura visto, y se apunta ese nombre para cada posicion por la que se
   pasa. Al llegar a la posicion de la ficha, el nombre que lleva puesto es el
   de la apertura de la que forma parte.

   Se guarda la ULTIMA coincidencia del camino y no la primera por lo mismo que
   en `nombrarLinea`: toda linea pasa por «Apertura de peon de rey» antes de
   llegar a «Caro-Kann, Avance», y lo que sirve es la concreta.

   Va en un worker porque recorrer varios arboles de curso son cientos de miles
   de posiciones, y hacerlo en el hilo principal congela la pantalla justo al
   entrar en la pestaña.
   =========================================================================== */

import { Chess } from './vendor/chess.js';
import { epdDe, tablaAperturas } from './aperturas.js';

/* Veinte jugadas. Mas alla no es apertura, y una ficha de la jugada 25 no se
   clasifica por la apertura sino por el final al que lleve. */
const PLY_MAX = 40;
/* Techo del recorrido, como en los otros cruces: un curso patologico con
   cientos de miles de nodos no puede dejar la pestaña colgada. */
const MAX_NODOS = 200000;

self.onmessage = async (e) => {
  try {
    const tabla = await tablaAperturas();
    postMessage({ ok: true, ...clasificar(tabla, e.data.fuentes || []) });
  } catch (err) {
    postMessage({ ok: false, error: String(err?.message || err) });
  }
};

function clasificar(tabla, fuentes) {
  const ch = new Chess();
  // epd -> "ECO|Nombre". Un objeto normal y no un Map: se manda por
  // structuredClone al hilo principal y ahi se consulta por clave; el Map no
  // aporta nada y cuesta mas de serializar.
  const mapa = Object.create(null);
  let vistos = 0;

  const anotar = (heredado) => {
    const epd = epdDe(ch.fen());
    const propio = tabla[epd];
    const v = propio || heredado;
    // No se pisa lo ya escrito con algo mas generico: si la posicion aparece en
    // dos cursos y en uno se llega por una linea con nombre concreto y en otro
    // por una generica, gana la concreta.
    if (v && (!mapa[epd] || propio)) mapa[epd] = v;
    return v;
  };

  for (const f of fuentes) {
    ch.reset();
    if (f.arbol) {
      const { san, hijos } = f.arbol;
      const bajar = (nodo, ply, heredado) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        const aqui = anotar(heredado);
        for (const h of hijos[nodo] || []) {
          vistos++;
          let ok = true;
          try { ch.move(san[h]); } catch { ok = false; }
          if (!ok) continue;
          bajar(h, ply + 1, aqui);
          ch.undo();
        }
      };
      bajar(0, 0, null);
    } else if (f.jugadas) {
      const sanes = String(f.jugadas).split(' ').filter(Boolean).slice(0, PLY_MAX);
      let heredado = null;
      for (let i = 0; i <= sanes.length; i++) {
        heredado = anotar(heredado);
        if (i === sanes.length) break;
        try { ch.move(sanes[i]); } catch { break; }
      }
    }
  }

  return { mapa, posiciones: Object.keys(mapa).length, recortado: vistos > MAX_NODOS };
}
