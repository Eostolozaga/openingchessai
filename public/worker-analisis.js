/* ===========================================================================
   OpeningChessAI — análisis de TUS partidas, fuera del hilo principal.

   Fase A de la pestaña Análisis: todo lo que se puede saber SIN motor.

     1. QUÉ JUEGAS. Tus partidas por color, bloque y apertura concreta, con tu
        puntuación en cada una. Las de peor rendimiento, aparte.

     2. DÓNDE TE SALES DE TU TEORÍA. Es la misma cuenta que Rival hace con las
        partidas de otro (teoria.js), pero aquí cambia de dueño y se vuelve
        incómoda —ver la cabecera de teoria.js—:

          · TE SALES TÚ: tenías la línea escrita y jugaste otra cosa. No es un
            hueco del repertorio, es que no juegas lo que preparas. Es el
            «dónde fallas» que se puede medir sin motor, y es exactamente lo
            que en la Fase C se convertirá en fichas: la posición, la jugada
            que tienes escrita y la que hiciste.
          · TE SACAN: el contrario jugó algo que tu libro no contempla. Eso sí
            es un hueco, y se ordena por cuántas veces te ha pasado.

   Las dos se agrupan por POSICIÓN + JUGADA y no por partida: equivocarse tres
   veces en el mismo sitio es un solo problema que estudiar, no tres.

   Las partidas se guardan ENTERAS (PLY_GUARDA), no cortadas a veinte jugadas
   como en Rival: la Fase B las va a pasar por el motor y ahí importa el medio
   juego y el final. Los cruces con el repertorio siguen mirando solo la
   apertura, que es lo que teoria.js ya limita por su cuenta.
   =========================================================================== */

import { Chess } from './vendor/chess.js';
import { epdDe, tablaAperturas } from './aperturas.js';
import { bloqueDe } from './bloques.js';
import { sanearPartidas } from './sanear.js';
import { salidasDeTeoria, resumenSalidas } from './teoria.js';

const PLY_GUARDA = 600;
/* Una apertura con menos partidas que esto no entra en «donde peor te va»: un
   0 % de una sola partida es mala suerte, no un patron. */
const MIN_DEBIL = 3;
const TOPE_GRUPOS = 25;

self.onmessage = async (e) => {
  const { partidas, blancas = [], negras = [] } = e.data;
  try {
    const tabla = await tablaAperturas();
    const s = sanearPartidas(Chess, tabla, partidas, PLY_GUARDA);
    postMessage({
      ok: true,
      partidas: s.partidas,
      saneo: { duplicadas: s.duplicadas, ilegales: s.ilegales },
      conRepertorio: { blancas: blancas.length, negras: negras.length },
      ...analizar(s.partidas, blancas, negras, tabla),
    });
  } catch (err) {
    postMessage({ ok: false, error: String(err?.message || err) });
  }
};

function analizar(partidas, blancas, negras, tabla) {
  /* --- 1. Resumen y aperturas ------------------------------------------- */
  const resumen = { total: partidas.length,
                    white: { n: 0, puntos: 0 }, black: { n: 0, puntos: 0 } };
  const grupos = new Map();

  partidas.forEach((p, i) => {
    const r = resumen[p.ladoRival];
    r.n++; r.puntos += p.puntos;

    const [b, nombreB] = bloqueDe(p.eco);
    const clave = p.ladoRival + '|' + b;
    let g = grupos.get(clave);
    if (!g) {
      g = { lado: p.ladoRival, bloque: b, nombre: nombreB, idx: [], puntos: 0,
            variantes: new Map() };
      grupos.set(clave, g);
    }
    g.idx.push(i);
    g.puntos += p.puntos;

    const nv = p.apertura || p.eco || 'Sin nombre';
    let v = g.variantes.get(nv);
    if (!v) { v = { nombre: nv, idx: [], puntos: 0 }; g.variantes.set(nv, v); }
    v.idx.push(i);
    v.puntos += p.puntos;
  });

  const pct = (x, n) => (n ? Math.round((x / n) * 100) : 0);
  const aperturas = [...grupos.values()].map(g => ({
    lado: g.lado, bloque: g.bloque, nombre: g.nombre,
    n: g.idx.length, score: pct(g.puntos, g.idx.length), idx: g.idx,
    variantes: [...g.variantes.values()]
      .map(v => ({ nombre: v.nombre, n: v.idx.length, score: pct(v.puntos, v.idx.length), idx: v.idx }))
      .sort((a, b) => b.n - a.n),
  })).sort((a, b) => b.n - a.n);

  const debiles = aperturas
    .flatMap(g => g.variantes.map(v => ({ ...v, lado: g.lado, bloque: g.nombre })))
    .filter(v => v.n >= MIN_DEBIL)
    .sort((a, b) => a.score - b.score || b.n - a.n)
    .slice(0, 6)
    .filter(v => v.score < 50);

  /* --- 2. Salidas de tu teoria ------------------------------------------ */
  // `suLado` es el lado del dueño de la lista: aqui, tu. Con eso `quien: 'el'`
  // quiere decir «te sales tu» y `'otro'`, «te sacan».
  const salidas = new Array(partidas.length).fill(null);
  for (const [lado, fuentes] of [['white', blancas], ['black', negras]]) {
    if (!fuentes.length) continue;
    const s = salidasDeTeoria(Chess, partidas, fuentes, lado);
    for (let i = 0; i < s.length; i++) if (s[i]) salidas[i] = s[i];
  }

  const propias = new Map(), sacan = new Map();
  salidas.forEach((s, i) => {
    if (!s || s.dentro) return;
    const destino = s.quien === 'el' ? propias : sacan;
    const clave = epdDe(s.fen) + '|' + s.san;
    let x = destino.get(clave);
    if (!x) {
      x = { san: s.san, fen: s.fen, ply: s.ply, linea: s.linea,
            previstas: s.previstas, nPrevistas: s.nPrevistas,
            lado: partidas[i].ladoRival,
            // Sin jugadas previas no hay apertura que nombrar: el nombre final de
            // la partida («French Advance» en la jugada 1) confunde.
            apertura: s.linea.length ? (nombreDe(tabla, s.linea) || partidas[i].apertura || null) : 'Primera jugada',
            idx: [], puntos: 0 };
      destino.set(clave, x);
    }
    x.idx.push(i);
    x.puntos += partidas[i].puntos;
  });

  const ordenar = (m) => [...m.values()]
    .map(x => ({ ...x, veces: x.idx.length, score: pct(x.puntos, x.idx.length) }))
    .sort((a, b) => b.veces - a.veces || a.ply - b.ply)
    .slice(0, TOPE_GRUPOS);

  /* --- 3. Familias, para las tarjetas estilo LotusChess -----------------
     La familia es el nombre antes de los dos puntos: «Sicilian Defense», no
     «Sicilian Defense: Najdorf Variation». Su tablero es la PRIMERA posicion
     de la partida que ya lleva ese nombre, la que la identifica de un vistazo;
     si varias partidas llegan por caminos distintos, gana la mas repetida. */
  const fams = new Map();
  partidas.forEach((p, i) => {
    const { familia, fen } = familiaDe(tabla, p);
    const clave = p.ladoRival + '|' + familia;
    let f = fams.get(clave);
    if (!f) { f = { lado: p.ladoRival, nombre: familia, idx: [], puntos: 0, fens: new Map(), dentro: 0, cruzadas: 0, propias: 0 }; fams.set(clave, f); }
    f.idx.push(i);
    f.puntos += p.puntos;
    if (fen) f.fens.set(fen, (f.fens.get(fen) || 0) + 1);
    const s = salidas[i];
    if (s) {
      f.cruzadas++;
      if (s.dentro || s.quien !== 'el') f.dentro++;
      if (!s.dentro && s.quien === 'el') f.propias++;
    }
  });
  const familias = [...fams.values()].map(f => ({
    lado: f.lado, nombre: f.nombre, idx: f.idx, n: f.idx.length,
    score: pct(f.puntos, f.idx.length),
    fen: [...f.fens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    // Fidelidad a tu teoria: partidas en las que NO te saliste tu.
    fidelidad: f.cruzadas ? pct(f.dentro, f.cruzadas) : null,
    propias: f.propias,
  })).sort((a, b) => b.n - a.n);

  return {
    familias,
    resumen: {
      ...resumen,
      scoreBlancas: pct(resumen.white.puntos, resumen.white.n),
      scoreNegras: pct(resumen.black.puntos, resumen.black.n),
      salidas: resumenSalidas(salidas),
    },
    aperturas, debiles, salidas,
    propias: ordenar(propias),
    sacan: ordenar(sacan),
    nPropias: propias.size, nSacan: sacan.size,
  };
}

const FAMILIA_PLY = 30;
const INICIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Familia de una partida y la primera posicion que la lleva. */
function familiaDe(tabla, p) {
  const ch = new Chess();
  const nombres = [];
  for (const san of p.sanes.slice(0, FAMILIA_PLY)) {
    try { if (!ch.move(san)) break; } catch { break; }
    const v = tabla[epdDe(ch.fen())];
    if (v) nombres.push([v.slice(v.indexOf('|') + 1), ch.fen()]);
  }
  const fam = (n) => String(n || '').split(':')[0].trim();
  const familia = fam(p.apertura) || fam(nombres.at(-1)?.[0]) || 'Sin clasificar';
  const primera = nombres.find(([n]) => fam(n) === familia);
  return { familia, fen: primera?.[1] || nombres.at(-1)?.[1] || INICIAL };
}

/** El nombre mas concreto por el que pasa una linea. */
function nombreDe(tabla, linea) {
  const ch = new Chess();
  let ultimo = null;
  for (const san of linea) {
    try { if (!ch.move(san)) break; } catch { break; }
    const v = tabla[epdDe(ch.fen())];
    if (v) ultimo = v;
  }
  return ultimo ? ultimo.slice(ultimo.indexOf('|') + 1) : null;
}
