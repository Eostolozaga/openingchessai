/* ===========================================================================
   OpeningChessAI — el retrato del rival, y sus partidas agrupadas por TU libro.

   DOS COSAS QUE NO ESTABAN, Y LA SEGUNDA ES LA QUE FALTABA DE VERDAD.

   1. QUE ABRE. Lo primero que uno quiere saber la noche antes no es un
      porcentaje de la Najdorf: es «¿este es de e4 o de d4?». Y con negras, la
      pregunta correcta no es «que defensas juega» sino «que me va a contestar
      A MI PRIMERA JUGADA» —si yo abro 1.c4, que juegue la Francesa no me
      afecta lo mas minimo—.

      Sale en una frase, tipo comentario de retransmision: «jugador de 1.e4 ·
      contra tu 1.d4 juega la Nimzoindia».

   2. SUS PARTIDAS AGRUPADAS POR TU REPERTORIO, NO POR EL ECO.

      Agrupar por ECO parece lo mismo y no lo es. El ECO clasifica la partida
      entera desde fuera: si el rival juega la Escandinava y tu no tienes ni una
      linea contra ella, la app te enseñaba un bloque «Aperturas irregulares ·
      12 partidas» que no puedes estudiar, y enterraba entre medias las cuatro
      partidas que SI recorren tu Catalana.

      Aqui el criterio es otro: una partida pertenece al grupo de la ULTIMA
      posicion de tu repertorio por la que pasa. Con eso:

        · Lo que no toca tu repertorio se va a un cajon aparte —«fuera de tu
          libro»— en vez de mezclarse con lo que si.
        · El nombre del grupo sale de una posicion que TU tienes escrita, asi
          que siempre es una apertura que juegas. Los nombres son generales
          —«Francesa», «Grunfeld»— porque el bloque es la unidad con la que se
          prepara, pero cual sale depende de tu libro, no del catalogo.
        · Como se indexa por posicion, las transposiciones caen donde deben.

   3. Y DENTRO DE CADA GRUPO, DONDE SE ACABA LA TEORIA Y QUIEN SE SALIO. Eso ya
      lo calculaba `teoria.js` partida a partida; lo que faltaba era sumarlo por
      grupo, que es como se lee: «en la Francesa se sale el en la 6 de media, y
      casi siempre por ...c5».
   =========================================================================== */

import { epdDe } from './aperturas.js';
import { fenesDe, epdsDe } from './posiciones.js';
import { bloqueDe } from './bloques.js';

const PLY_MAX = 40;
const MAX_NODOS = 120000;
/* Antes de la segunda media jugada el ECO no dice nada: 1.e4 es B00 y 1.d4 es
   A40, asi que nombrar ahi mandaria medio libro a «Alekhine, Pirc y Moderna».
   A partir de 1.e4 e6 la tabla ya dice Francesa. Es el mismo umbral que usa el
   cruce de elite, y por la misma razon. */
const PLY_NOMBRE = 2;

/* ===========================================================================
   1. Las primeras jugadas de tu repertorio
   =========================================================================== */
/**
 * Raiz del repertorio: primera jugada -> respuestas escritas.
 *
 * Sirve para los dos colores sin cambiar nada, y eso es lo bonito del arbol:
 * en un curso de blancas la raiz son TUS aperturas y sus hijos son lo que le
 * contemplas al rival; en uno de negras la raiz son SUS aperturas y los hijos
 * son tus defensas. La misma funcion contesta las dos preguntas.
 */
export function primerasDelRepertorio(fuentes) {
  const raiz = new Map();
  const meter = (a, b) => {
    let s = raiz.get(a);
    if (!s) { s = new Set(); raiz.set(a, s); }
    if (b) s.add(b);
  };

  for (const f of fuentes || []) {
    if (f.arbol) {
      const { san, hijos } = f.arbol;
      for (const h of hijos[0] || []) {
        const kids = hijos[h] || [];
        if (!kids.length) meter(san[h], null);
        for (const k of kids) meter(san[h], san[k]);
      }
    } else if (f.jugadas) {
      const s = String(f.jugadas).split(' ').filter(Boolean);
      if (s[0]) meter(s[0], s[1] || null);
    }
  }
  return raiz;
}

/* ===========================================================================
   2. Que abre
   =========================================================================== */
/**
 * El retrato: que juega de salida con cada color.
 *
 * Devuelve
 *   {
 *     blancas: { n, reparto:[{san,n,pct,score}], etiqueta },
 *     negras:  { n, contra:[{san, mia, n, respuestas:[{san,n,pct,score,nombre}],
 *                            etiqueta}], etiqueta },
 *   }
 *
 * `mia` marca las primeras jugadas que TU juegas. Las tuyas van primero y las
 * demas detras, no fuera: saber que contra 1.e4 juega la Siciliana cuando tu
 * abres 1.d4 no te prepara la partida, pero si te dice si es un jugador de
 * posicion o de complicaciones, y eso vale para un rato.
 */
export function perfilDeAperturas(Chess, partidas, misBlancas, tabla) {
  const ch = new Chess();

  /* --- con blancas: su primera jugada --------------------------------- */
  const suyas = new Map();
  let nB = 0;
  for (const p of partidas) {
    if (p.ladoRival !== 'white' || !p.sanes?.length) continue;
    nB++;
    acumular(suyas, p.sanes[0], p.puntos);
  }
  const reparto = ordenar(suyas, nB);

  /* --- con negras: que contesta, y a que ------------------------------ */
  // Agrupado por la primera jugada de SU CONTRARIO, que es la que a ti te
  // corresponde jugar. Un solo monton de «defensas que juega» no vale: contra
  // 1.d4 y contra 1.e4 no juega lo mismo nadie.
  const porPrimera = new Map();
  let nN = 0;
  for (const p of partidas) {
    if (p.ladoRival !== 'black' || p.sanes?.length < 2) continue;
    nN++;
    const abre = p.sanes[0];
    let g = porPrimera.get(abre);
    if (!g) { g = { san: abre, n: 0, resp: new Map() }; porPrimera.set(abre, g); }
    g.n++;
    acumular(g.resp, p.sanes[1], p.puntos);
  }

  const contra = [...porPrimera.values()].map(g => {
    const respuestas = ordenar(g.resp, g.n).map(r => ({
      ...r, nombre: nombreDe(ch, tabla, [g.san, r.san]),
    }));
    return {
      san: g.san, n: g.n, mia: misBlancas.has(g.san), respuestas,
      etiqueta: respuestas.length
        ? `contra 1.${g.san} ${frase(respuestas[0], g.n)}`
        : null,
    };
  }).sort((a, b) => (b.mia - a.mia) || (b.n - a.n));

  return {
    blancas: { n: nB, reparto, etiqueta: etiquetaAbre(reparto) },
    negras: { n: nN, contra,
              // La frase de negras es la de TU primera jugada si la tiene; si
              // no, la de la que mas le juegan. Poner las dos seria un parrafo,
              // y esto es un titular.
              etiqueta: (contra.find(c => c.mia) || contra[0])?.etiqueta || null },
  };
}

function acumular(mapa, san, puntos) {
  if (!san) return;
  let e = mapa.get(san);
  if (!e) { e = { san, n: 0, puntos: 0 }; mapa.set(san, e); }
  e.n++; e.puntos += puntos ?? 0.5;
}

const ordenar = (mapa, total) => [...mapa.values()]
  .sort((a, b) => b.n - a.n || a.san.localeCompare(b.san))
  .map(e => ({ san: e.san, n: e.n,
               pct: total ? Math.round((e.n / total) * 100) : 0,
               score: Math.round((e.puntos / e.n) * 100) }));

/** El nombre de apertura de una linea corta, si la tabla la reconoce. */
function nombreDe(ch, tabla, sanes) {
  ch.reset();
  let nombre = null;
  for (let i = 0; i < sanes.length; i++) {
    try { if (!ch.move(sanes[i])) break; } catch { break; }
    if (i + 1 < PLY_NOMBRE) continue;
    const v = tabla[epdDe(ch.fen())];
    if (v) nombre = bloqueDe(v.slice(0, v.indexOf('|')))[1];
  }
  return nombre && nombre !== 'Sin clasificar' ? nombre : null;
}

/** «jugador de 1.e4», «1.e4 y 1.d4», «abre variado». */
function etiquetaAbre(reparto) {
  if (!reparto.length) return null;
  const [a, b] = reparto;
  if (a.pct >= 60) return `jugador de 1.${a.san}`;
  if (b && a.pct + b.pct >= 75) return `abre con 1.${a.san} y 1.${b.san}`;
  return `abre variado (1.${reparto.slice(0, 3).map(r => r.san).join(', 1.')}…)`;
}

/** «responde …e6, Francesa (11 de 14)».
 *
 *  Empieza por la JUGADA y no por el nombre a proposito, y no es solo estilo:
 *  el nombre del bloque no siempre es un sustantivo que admita articulo —«la
 *  Sistemas con 1.d4 Cf6» no se puede escribir— y ademas la jugada es el dato
 *  concreto. El nombre va detras, como aclaracion, y desaparece limpiamente
 *  cuando la tabla no reconoce la linea. */
const frase = (r, total) =>
  `responde …${r.san}${r.nombre ? ', ' + r.nombre : ''} (${r.n} de ${total})`;

/* ===========================================================================
   3. El mapa de TU repertorio, con nombres
   =========================================================================== */
/**
 * EPD -> { ply, nombre } de todo lo que hay escrito de un color.
 *
 * `nombre` es el bloque de apertura de esa posicion cuando la tabla la
 * reconoce y la posicion esta lo bastante honda para que el ECO signifique
 * algo. Se guarda aqui y no se busca al vuelo porque la tabla se consulta una
 * vez por posicion del repertorio —unos miles— en vez de una vez por posicion
 * de cada partida —cientos de miles—.
 */
export function mapaDelRepertorio(ch, fuentes, tabla) {
  const mapa = new Map();
  let vistos = 0;

  const anotar = (ply, epd = epdDe(ch.fen())) => {
    const y = mapa.get(epd);
    if (y !== undefined && y.ply <= ply) return;
    const v = ply >= PLY_NOMBRE ? tabla[epd] : null;
    const nom = v ? bloqueDe(v.slice(0, v.indexOf('|')))[1] : null;
    mapa.set(epd, { ply, nombre: nom && nom !== 'Sin clasificar' ? nom : (y?.nombre || null) });
  };

  for (const f of fuentes || []) {
    ch.reset();
    if (f.arbol && fenesDe(f.arbol)) {
      // Fase 33: las posiciones ya calculadas, sin mover piezas.
      const { hijos } = f.arbol;
      const E = epdsDe(fenesDe(f.arbol));
      const bajar = (nodo, ply) => {
        if (ply > PLY_MAX || vistos > MAX_NODOS) return;
        anotar(ply, E[nodo]);
        for (const h of hijos[nodo] || []) {
          vistos++;
          if (E[h] == null) continue;
          bajar(h, ply + 1);
        }
      };
      bajar(0, 0);
    } else if (f.arbol) {
      const { san, hijos } = f.arbol;
      const bajar = (nodo, ply) => {
        if (ply > PLY_MAX || vistos > MAX_NODOS) return;
        anotar(ply);
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
      const sanes = String(f.jugadas).split(' ').filter(Boolean).slice(0, PLY_MAX);
      for (let i = 0; i <= sanes.length; i++) {
        anotar(i);
        if (i === sanes.length) break;
        try { if (!ch.move(sanes[i])) break; } catch { break; }
      }
    }
  }
  return mapa;
}

/* ===========================================================================
   4. Sus partidas, repartidas por tu libro
   =========================================================================== */
/**
 * Agrupa las partidas del rival de un color por la parte de TU repertorio que
 * recorren.
 *
 * @param ch        instancia de Chess reutilizable
 * @param partidas  todas las suyas (se filtran por `suLado` aqui dentro)
 * @param mapa      el de `mapaDelRepertorio` para el color con el que juegas tu
 * @param salidas   el array de `salidasDeTeoria`, alineado con `partidas`
 *
 * Devuelve `{ grupos, fuera }`:
 *
 *   grupos[i] = { clave, nombre, miColor, suLado, n, score, hasta,
 *                 idx:[...], salidas:{el,otro,dentro,total},
 *                 corte: mediana de la jugada en que se acaba la teoria,
 *                 suyas: [{san, ply, veces, fen, linea, previstas, nPrevistas}] }
 *   fuera     = { n, idx } — las que no pisan tu libro mas alla de la salida
 */
export function agruparPorRepertorio(ch, partidas, mapa, miColor, salidas) {
  const suLado = miColor === 'white' ? 'black' : 'white';
  const grupos = new Map();
  const fuera = [];

  for (let i = 0; i < partidas.length; i++) {
    const p = partidas[i];
    if (p.ladoRival !== suLado || !p.sanes?.length) continue;

    // Hasta donde llega dentro de tu libro, y con que nombre. El nombre se
    // arrastra: una vez que la partida es «Francesa», seguir cinco jugadas mas
    // por posiciones sin nombre no la saca de la Francesa.
    let hasta = 0, nombre = null;
    ch.reset();
    const pe = epdsDe(p._fen);
    for (let ply = 1; ply <= p.sanes.length && ply <= PLY_MAX; ply++) {
      if (pe) { if (ply >= pe.length) break; }
      else { try { if (!ch.move(p.sanes[ply - 1])) break; } catch { break; } }
      const e = mapa.get(pe ? pe[ply] : epdDe(ch.fen()));
      if (!e) {
        // Diez medias jugadas fuera y no vuelve. Se sigue un poco por si hay
        // transposicion —pasa mas de lo que parece— pero no hasta el final.
        if (ply - hasta > 10) break;
        continue;
      }
      hasta = ply;
      if (e.nombre) nombre = e.nombre;
    }

    if (!hasta) { fuera.push(i); continue; }

    // Sin nombre reconocido, el grupo se llama por la primera jugada. «Primeras
    // jugadas de tu libro» a secas juntaba en un monton las partidas que
    // empiezan 1.e4 con las que empiezan 1.c4, que no tienen nada que ver: la
    // unica forma de estudiarlas es separadas.
    const clave = nombre || ('·' + p.sanes[0]);
    let g = grupos.get(clave);
    if (!g) {
      g = { clave, nombre: nombre || `Tras 1.${p.sanes[0]}`,
            miColor, suLado, idx: [], puntos: 0, hondos: [],
            salidas: { el: 0, otro: 0, dentro: 0, total: 0 },
            cortes: [], suyas: new Map() };
      grupos.set(clave, g);
    }
    g.idx.push(i);
    g.puntos += p.puntos ?? 0.5;
    g.hondos.push(hasta);

    const s = salidas?.[i];
    if (s) {
      g.salidas.total++;
      if (s.dentro) g.salidas.dentro++;
      else if (s.quien === 'el') {
        g.salidas.el++;
        g.cortes.push(s.ply);
        // Solo se acumulan las salidas SUYAS. Las de su contrario no son
        // preparacion de nadie que te vayas a encontrar: contigo esa posicion
        // no se da, porque ahi juegas tu.
        const k = (s.fen || '') + '|' + s.san;
        const y = g.suyas.get(k);
        if (y) y.veces++;
        else g.suyas.set(k, { san: s.san, ply: s.ply, fen: s.fen, veces: 1,
                              linea: s.linea || [], previstas: s.previstas || [],
                              nPrevistas: s.nPrevistas || 0 });
      } else { g.salidas.otro++; g.cortes.push(s.ply); }
    }
  }

  const salida = [...grupos.values()].map(g => ({
    clave: g.clave, nombre: g.nombre, miColor: g.miColor, suLado: g.suLado,
    n: g.idx.length, idx: g.idx,
    score: Math.round((g.puntos / g.idx.length) * 100),
    // La MEDIANA y no la media: una partida que se sale en la 2 y otra en la 30
    // dan una media de 16, que no le pasa a ninguna de las dos.
    hasta: mediana(g.hondos),
    corte: g.cortes.length ? mediana(g.cortes) : null,
    salidas: g.salidas,
    suyas: [...g.suyas.values()].sort((a, b) => b.veces - a.veces || a.ply - b.ply).slice(0, 6),
  })).sort((a, b) => b.n - a.n);

  return { grupos: salida, fuera: { n: fuera.length, idx: fuera } };
}

function mediana(xs) {
  if (!xs.length) return 0;
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)];
}
