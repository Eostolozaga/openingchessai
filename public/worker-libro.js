/* ===========================================================================
   OpeningChessAI — el libro del rival, fuera del hilo principal.

   El panel de huecos contesta "donde se te escapa". Esto contesta la otra
   pregunta, la que se hace uno la noche antes: "y este tio, ¿que juega?".
   No una lista de bloques, sino un libro navegable — la posicion, lo que ha
   jugado el ahi, cuantas veces, como le fue, y que partidas suyas pasaron por
   ahi para poder abrirlas.

   Por que un libro y no la lista de partidas a secas: cuatrocientas partidas
   ordenadas por fecha no se estudian. Las mismas cuatrocientas plegadas en un
   arbol por frecuencia caben en una pantalla y dicen, de un vistazo, que juega
   el 70 % de las veces y que solo probo dos veces en 2019.

   TRES DECISIONES QUE IMPORTAN

   1. UN LIBRO POR COLOR SUYO, SIEMPRE. Mezclar sus partidas con blancas y con
      negras deja la raiz sin sentido: en unas 1.e4 la juega el y en otras se la
      juegan. Aqui el color es un parametro obligatorio, no un filtro opcional.

   2. SE CUENTAN LAS JUGADAS DE LOS DOS. Las suyas son lo que se prepara; las de
      sus rivales son el contexto que dice si esa posicion se da o no se da. Lo
      que se marca en cada posicion es de quien es el turno, y la pantalla lo
      dice con todas las letras.

   3. LOS PUNTOS SON SIEMPRE SUYOS. En una jugada suya, el porcentaje es como le
      va cuando la juega. En una jugada de su rival, es como le va a EL cuando
      se la juegan. Es la misma medida —su rendimiento— vista desde los dos
      lados, y es la unica que sirve para decidir a que llevarle.
   =========================================================================== */

import { Chess } from './vendor/chess.js';
import { epdDe } from './aperturas.js';
import { bloqueDe } from './bloques.js';

/* El mismo techo que el resto: veinte jugadas de cada. Tiene que ir a la par
   con el volcado FIDE (`herramientas/exportar_rivales.py`), porque si el libro
   mira mas lejos de lo que el volcado guarda, las partidas OTB se cortan en
   seco a mitad de linea y parece un fallo. */
const PLY_MAX = 40;

self.onmessage = async (e) => {
  try {
    postMessage({ ok: true, ...construir(e.data) });
  } catch (err) {
    postMessage({ ok: false, error: String(err?.message || err) });
  }
};

function construir({ partidas, fuentes, lado, bloque, soloIndices = null }) {
  const ch = new Chess();

  // Los indices son los ORIGINALES del array que tiene la pestana: asi puede
  // pintar la ficha de la partida (fecha, rival, resultado) sin que el worker
  // tenga que devolverle datos que ya tiene.
  //
  // `soloIndices` gana sobre `bloque` porque es mas preciso, no otro filtro:
  // cuando la pestana agrupa por el repertorio, ya sabe EXACTAMENTE que
  // partidas van en el grupo —lo ha decidido posicion a posicion— y volver a
  // filtrarlas aqui por su ECO las descuadraria. El ECO clasifica la partida
  // entera; el grupo, la parte de tu libro que recorre, y no tienen por que
  // coincidir.
  const soloSet = soloIndices ? new Set(soloIndices) : null;
  const usados = [];
  partidas.forEach((p, i) => {
    if (p.ladoRival !== lado) return;
    if (soloSet) { if (soloSet.has(i)) usados.push(i); return; }
    if (bloque && bloqueDe(p.eco)[0] !== bloque) return;
    usados.push(i);
  });

  const pos = Object.create(null);

  for (const i of usados) {
    const p = partidas[i];
    ch.reset();
    for (let ply = 0; ply <= PLY_MAX; ply++) {
      const epd = epdDe(ch.fen());
      let e = pos[epd];
      if (!e) {
        e = pos[epd] = {
          ply,
          fen: ch.fen(),
          // 'el' o 'otro': de quien es el turno en esta posicion.
          quien: (ply % 2 === 0) === (lado === 'white') ? 'el' : 'otro',
          n: 0, j: Object.create(null), g: [],
        };
      }
      // Una partida cuenta UNA vez por posicion aunque pase dos veces por ella
      // (una repeticion, un caballo que va y vuelve). Como las partidas se
      // recorren de una en una, basta con mirar la ultima anotada.
      if (e.g[e.g.length - 1] !== i) { e.g.push(i); e.n++; }

      const san = p.sanes[ply];
      if (ply === PLY_MAX || !san) break;
      let jj = e.j[san];
      if (!jj) jj = e.j[san] = { veces: 0, puntos: 0 };
      jj.veces++;
      jj.puntos += p.puntos;
      try { ch.move(san); } catch { break; }
    }
  }

  // Las jugadas de cada posicion, ya ordenadas por frecuencia: ordenarlas aqui
  // y no al pintar significa que la flecha "adelante" y la lista coinciden
  // siempre, sin que nadie tenga que acordarse de ordenar igual en dos sitios.
  for (const epd of Object.keys(pos)) {
    const e = pos[epd];
    e.jugadas = Object.entries(e.j)
      .map(([san, d]) => ({ san, veces: d.veces, puntos: d.puntos }))
      .sort((a, b) => b.veces - a.veces || a.san.localeCompare(b.san));
    delete e.j;
  }

  return { posiciones: pos, partidas: usados, mias: cubiertas(ch, fuentes, pos) };
}

/**
 * Que tienes TU escrito en las posiciones por las que pasa su libro.
 *
 * Se recorre el repertorio entero pero solo se anota lo que cae dentro del
 * libro. Devolver el arbol completo serian decenas de miles de entradas
 * cruzando el postMessage para que la pantalla usase treinta; la interseccion
 * cabe en unos cientos.
 *
 * Con techo de nodos, y generoso. Al subir PLY_MAX de 24 a 40 el arbol
 * alcanzable se multiplica, y sin tope un curso de los gordos podia tener al
 * worker un rato largo solo para poner unos cuantos ✓. El tope se elige alto a
 * proposito: quedarse corto aqui no rompe nada, solo deja alguna jugada suya
 * sin marcar, que es un fallo mucho mas barato que la pantalla en blanco.
 */
const MAX_NODOS = 200000;

function cubiertas(ch, fuentes, pos) {
  const mias = Object.create(null);
  if (!fuentes?.length) return mias;
  let vistos = 0;

  const anotar = (epd, sanes) => {
    if (!pos[epd] || !sanes.length) return;
    const y = mias[epd] || (mias[epd] = []);
    for (const s of sanes) if (!y.includes(s)) y.push(s);
  };

  for (const f of fuentes) {
    ch.reset();
    if (f.arbol) {
      const { san, hijos } = f.arbol;
      const bajar = (nodo, ply) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        anotar(epdDe(ch.fen()), (hijos[nodo] || []).map(h => san[h]));
        for (const h of hijos[nodo] || []) {
          vistos++;
          let ok = true;
          try { ch.move(san[h]); } catch { ok = false; }
          if (!ok) continue;
          bajar(h, ply + 1);
          ch.undo();
        }
      };
      bajar(0, 0);
    } else if (f.jugadas) {
      const sanes = f.jugadas.split(' ').filter(Boolean).slice(0, PLY_MAX);
      for (let i = 0; i < sanes.length; i++) {
        anotar(epdDe(ch.fen()), [sanes[i]]);
        try { ch.move(sanes[i]); } catch { break; }
      }
    }
  }
  return mias;
}
