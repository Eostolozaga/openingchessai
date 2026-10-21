/* ===========================================================================
   OpeningChessAI — quién se sale de tu teoría.

   LA PREGUNTA. Una partida de tu rival se juega contra un tercero. Cuando esa
   partida se sale de tu repertorio, hay dos motivos posibles y no valen lo
   mismo:

     · SE SALE EL. Juega algo que tu libro no cubre. Eso es un hueco de verdad:
       si le toca contigo, va a jugar eso y no vas a tener respuesta escrita.

     · SE SALE EL OTRO. La partida abandona tus lineas porque su contrario —que
       no vas a ser tu— eligio otra cosa. De ahi no se aprende nada sobre su
       preparacion: simplemente nunca llego a ponerse a prueba. Es ruido, y
       hasta ahora se contaba igual que lo otro.

   Y en TUS partidas la misma cuenta cambia de dueno y se vuelve incomoda:

     · TE SALES TU. Tienes la linea escrita y jugaste otra cosa. No es un hueco
       del repertorio, es que no juegas lo que preparas — que es un problema
       distinto y normalmente mayor.

     · SE SALE TU RIVAL. Te sacaron del libro. Eso si es un hueco.

   COMO SE CALCULA. Se reproduce la partida jugada a jugada sobre el mapa de
   posiciones de tu repertorio, y se para en la PRIMERA jugada que ese mapa no
   contempla. De quien sea el turno en esa jugada, ese es el que se sale.

   La primera y no todas: despues de la primera, la partida ya va por su cuenta
   y contar mas «salidas» seria contar el eco de la misma.

   INDEXADO POR POSICION, no por camino, como todo lo demas de esta app: asi la
   partida que llega a tu Najdorf por 2.Cf3 en vez de por 2.Cc3 se reconoce
   como cubierta, que es lo correcto.
   =========================================================================== */

import { epdDe } from './aperturas.js';
import { fenesDe, epdsDe } from './posiciones.js';

/* El mismo techo de siempre: veinte jugadas de cada. Mas alla ya no es
   apertura, y «se salio de tu teoria en la jugada 28» no significa nada. */
const PLY_MAX = 40;
/* Techo del recorrido del arbol, como en los otros cruces. */
const MAX_NODOS = 200000;

/**
 * Para cada partida, quién se salió primero de tu repertorio.
 *
 * Devuelve un array alineado con `partidas`. Las partidas del otro color —o
 * sin repertorio contra el que cruzarlas— salen a `null`.
 *
 *   { ply, san, quien: 'el' | 'otro', previstas: [...], nPrevistas, fen }
 *   { dentro: true, ply }        la partida no se sale en las 20 jugadas
 *
 * `quien: 'el'` es siempre el dueño de la lista de partidas —el rival en la
 * pestaña Rival, tú en las tuyas—. Quien pone las palabras es la pantalla,
 * porque «él» y «tú» no significan lo mismo en las dos.
 */
export function salidasDeTeoria(Chess, partidas, fuentes, suLado) {
  const fuera = new Array(partidas.length).fill(null);
  if (!fuentes?.length) return fuera;

  const suyas = [];
  partidas.forEach((p, i) => { if (p.ladoRival === suLado) suyas.push(i); });
  if (!suyas.length) return fuera;

  const ch = new Chess();

  // DOS PASADAS, y la primera existe por memoria. Construir el mapa de TODO el
  // repertorio serian cientos de miles de posiciones con su conjunto de
  // jugadas cada una, y eso en un movil es medio giga. Lo que hace falta es
  // solo lo que estas partidas pisan: unos pocos miles.
  const quiero = new Set();
  for (const i of suyas) {
    // Con los FEN de la partida ya calculados (Fase 33), las mismas posiciones
    // sin volver a moverla. `_fen` trae una mas que jugadas: la del final.
    const pe = epdsDe(partidas[i]._fen);
    if (pe) {
      const n = Math.min(partidas[i].sanes.length, PLY_MAX);
      for (let ply = 0; ply <= n && ply < pe.length; ply++) quiero.add(pe[ply]);
      continue;
    }
    ch.reset();
    for (let ply = 0; ply < partidas[i].sanes.length && ply < PLY_MAX; ply++) {
      quiero.add(epdDe(ch.fen()));
      try { if (!ch.move(partidas[i].sanes[ply])) break; } catch { break; }
    }
    quiero.add(epdDe(ch.fen()));
  }

  const cob = cobertura(ch, fuentes, quiero);
  if (!cob.size) return fuera;

  for (const i of suyas) fuera[i] = salidaDe(ch, cob, partidas[i], suLado);
  return fuera;
}

/**
 * Mapa posicion -> jugadas que tu repertorio contempla ahi.
 *
 * Se recorre el arbol entero pero solo se apunta lo que cae dentro de
 * `quiero`. Las fuentes de los dos colores se mezclan a proposito: tu libro es
 * la union de todo lo que tienes escrito, y una posicion que aparece en dos
 * cursos con continuaciones distintas las cubre las dos.
 */
function cobertura(ch, fuentes, quiero) {
  const mapa = new Map();
  let vistos = 0;

  const anotar = (epd, sanes) => {
    if (!quiero.has(epd)) return;
    let s = mapa.get(epd);
    if (!s) { s = new Set(); mapa.set(epd, s); }
    for (const x of sanes) s.add(x);
  };

  for (const f of fuentes) {
    ch.reset();
    if (f.arbol && fenesDe(f.arbol)) {
      // El mismo recorrido leyendo las posiciones ya calculadas (Fase 33). Un
      // null es una jugada ilegal: el camino lento se la saltaba igual.
      const { san, hijos } = f.arbol;
      const E = epdsDe(fenesDe(f.arbol));
      const bajar = (nodo, ply) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        const kids = hijos[nodo] || [];
        anotar(E[nodo], kids.map(h => san[h]));
        for (const h of kids) {
          vistos++;
          if (E[h] == null) continue;
          bajar(h, ply + 1);
        }
      };
      bajar(0, 0);
    } else if (f.arbol) {
      const { san, hijos } = f.arbol;
      const bajar = (nodo, ply) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        const kids = hijos[nodo] || [];
        anotar(epdDe(ch.fen()), kids.map(h => san[h]));
        for (const h of kids) {
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
      const sanes = String(f.jugadas).split(' ').filter(Boolean).slice(0, PLY_MAX);
      for (let i = 0; i < sanes.length; i++) {
        anotar(epdDe(ch.fen()), [sanes[i]]);
        try { if (!ch.move(sanes[i])) break; } catch { break; }
      }
    }
  }
  return mapa;
}

/** La primera jugada de la partida que tu repertorio no contempla. */
function salidaDe(ch, cob, p, suLado) {
  ch.reset();
  const pf = p._fen, pe = epdsDe(pf);
  for (let ply = 0; ply < p.sanes.length && ply < PLY_MAX; ply++) {
    const fen = pf ? pf[ply] : ch.fen();
    const set = cob.get(pe ? pe[ply] : epdDe(fen));
    const san = p.sanes[ply];

    if (!set || !set.has(san)) {
      // De quien es el turno aqui. En ply 0 mueven blancas, y a partir de ahi
      // se alterna: si el par/impar coincide con su color, la jugada es suya.
      const suya = (ply % 2 === 0) === (suLado === 'white');
      return {
        ply, san, fen,
        quien: suya ? 'el' : 'otro',
        // El camino hasta aqui. Sin esto la salida se puede contar pero no
        // abrir: el editor de repertorio y el libro necesitan la linea, no solo
        // la posicion, para saber por donde se ha llegado.
        linea: p.sanes.slice(0, ply),
        // Lo que TU tienes escrito ahi. Sin esto la salida es un reproche sin
        // informacion: lo util es «juega ...g6 y tu solo tienes ...e6».
        previstas: set ? [...set].slice(0, 4) : [],
        nPrevistas: set ? set.size : 0,
      };
    }
    if (pf) continue;
    try { if (!ch.move(san)) return null; } catch { return null; }
  }
  return { dentro: true, ply: Math.min(p.sanes.length, PLY_MAX) };
}

/* ===========================================================================
   Lo que la pantalla necesita saber
   =========================================================================== */

/** Cuenta para una tanda de partidas: cuantas se sale cada uno. */
export function resumenSalidas(salidas) {
  const r = { total: 0, el: 0, otro: 0, dentro: 0 };
  for (const s of salidas) {
    if (!s) continue;
    r.total++;
    if (s.dentro) r.dentro++;
    else if (s.quien === 'el') r.el++;
    else r.otro++;
  }
  return r;
}

/** «se sale él en la 7» y su color de etiqueta, con las palabras de cada
 *  pantalla. `mio` = true cuando la lista es de TUS partidas. */
export function etiquetaSalida(s, mio = false) {
  if (!s) return null;
  if (s.dentro) {
    return { texto: 'dentro de tu libro', clase: 'ok',
             ayuda: `Las ${Math.ceil(s.ply / 2)} primeras jugadas están en tu repertorio.` };
  }
  const jugada = Math.ceil((s.ply + 1) / 2);
  if (s.quien === 'el') {
    return mio
      // Que te salgas TU no es un hueco, es otra cosa, y la etiqueta no debe
      // sugerir que hay algo que estudiar: hay algo que decidir.
      ? { texto: `te sales tú en la ${jugada}`, clase: 'brass',
          ayuda: `Jugaste ${s.san}${s.previstas.length
            ? ` y tu repertorio dice ${s.previstas.join(', ')}` : ''}.` }
      : { texto: `se sale él en la ${jugada}`, clase: 'mal',
          ayuda: `Jugó ${s.san}${s.previstas.length
            ? ` y tú tienes ${s.previstas.join(', ')}` : ' y no tienes nada escrito ahí'}.` };
  }
  return mio
    ? { texto: `te sacan en la ${jugada}`, clase: 'mal',
        ayuda: `Te jugaron ${s.san}${s.previstas.length
          ? ` y tú tienes ${s.previstas.join(', ')}` : ' y no tienes nada escrito ahí'}.` }
    // La explicacion larga —por que esto no dice nada de SU preparacion— va una
    // sola vez al pie de la lista y no repetida en cada fila: pegada a cada
    // partida son treinta parrafos identicos que nadie lee a partir del
    // segundo.
    : { texto: `se sale su rival en la ${jugada}`, clase: '',
        ayuda: `Deja tus líneas por ${s.san}, que juega su contrario.` };
}
