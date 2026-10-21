/* ===========================================================================
   OpeningChessAI — analisis de un rival, fuera del hilo principal.

   Trescientas partidas por veinte jugadas son varios miles de posiciones que
   reproducir con chess.js. En el hilo de la interfaz eso son segundos de
   pantalla congelada justo cuando el usuario acaba de pulsar un boton; aqui
   no se nota.

   Responde a dos preguntas distintas, y conviene no confundirlas:

     1. QUE JUEGA. Agrupa sus partidas por bloque de apertura y color. El
        bloque, no el ECO suelto: B90 y B96 son las dos Najdorf y separarlas
        parte el recuento en trozos que no dicen nada. La tabla de rangos
        viene del trabajo que ya estaba hecho en aplicar_bloques_rival.py.

     2. DONDE SE SALDRIA DE TU TEORIA.

   La segunda tiene una trampa que costo dos intentos entender.

   Lo evidente es reproducir sus partidas contra tu repertorio y anotar donde
   dejan de coincidir. No funciona, y no por un fallo de implementacion: en
   sus partidas, el que lleva TU color no eres tu, es otro que juega lo que le
   parece. A la tercera jugada ese otro se sale de tu repertorio, la posicion
   deja de estar en tu libro, y con ella se pierde todo lo que el rival hiciera
   despues. El panel sale vacio y con la conclusion falsa de que no hay nada
   que preparar.

   Lo que si funciona es al reves, y es el "cruce en espejo" de siempre:

     · Se indexan SUS partidas por posicion: donde ha estado y que jugo alli.
     · Se recorre TU repertorio. En cada posicion en la que le tocaria mover a
       el, se mira si esa posicion aparece en sus partidas.
     · Si aparece y lo que jugo alli no esta en tu repertorio, eso es un hueco
       REAL: no es una conjetura sobre lo que podria hacer, es algo que ya ha
       hecho en esa posicion exacta.

   Indexar por posicion en vez de por camino ademas regala las transposiciones,
   que en apertura no es un detalle menor.
   =========================================================================== */

import { Chess } from './vendor/chess.js';
import { epdDe, tablaAperturas } from './aperturas.js';
import { bloqueDe } from './bloques.js';
import { sanearPartidas } from './sanear.js';
import { fenesDeArbol, fenesDe, epdsDe } from './posiciones.js';
import { salidasDeTeoria, resumenSalidas } from './teoria.js';
import { perfilDeAperturas, primerasDelRepertorio,
         mapaDelRepertorio, agruparPorRepertorio } from './estilo.js';

/* Veinte jugadas de cada. Empezo en doce y se quedaba corto: a esa altura
   muchas aperturas siguen en teoria conocida y el cruce cortaba justo donde
   empieza lo que hay que preparar. Veinte cubre la apertura entera de casi
   todo sin meterse en medio juego, que es donde la coincidencia de posiciones
   se vuelve anecdotica. */
const PLY_MAX = 40;
/* Techo de nodos al recorrer tu repertorio. Sube con PLY_MAX: bajar ocho plies
   mas multiplica los nodos alcanzables, y con el techo viejo el recorrido se
   habria cortado a media profundidad sin decir nada —que es la peor forma de
   quedarse corto, porque el panel sale bien y simplemente le faltan huecos—. */
const MAX_NODOS = 120000;

/* ===========================================================================
   Sus partidas, indexadas por posicion
   =========================================================================== */
/**
 * EPD -> que jugo el rival ahi, cuantas veces y con que resultado.
 *
 * Solo se anotan las posiciones en las que movia EL. Lo que hiciera su
 * contrario no dice nada de como prepararle: ese no vas a ser tu.
 */
function indexarRival(ch, partidas, lado) {
  const mapa = new Map();

  for (const p of partidas) {
    if (p.ladoRival !== lado) continue;
    ch.reset();
    const pe = epdsDe(p._fen);
    for (let i = 0; i < p.sanes.length && i < PLY_MAX; i++) {
      if ((i % 2 === 0) === (lado === 'white')) {
        const epd = pe ? pe[i] : epdDe(ch.fen());
        let e = mapa.get(epd);
        if (!e) { e = new Map(); mapa.set(epd, e); }
        let j = e.get(p.sanes[i]);
        if (!j) { j = { veces: 0, puntos: 0 }; e.set(p.sanes[i], j); }
        j.veces++;
        j.puntos += p.puntos;
      }
      if (pe) continue;
      try { ch.move(p.sanes[i]); } catch { break; }
    }
  }
  return mapa;
}

/* ===========================================================================
   Tu repertorio, recorrido en busca de sus jugadas
   =========================================================================== */
/**
 * Recorre el arbol del repertorio de un color y devuelve, para cada posicion
 * en la que le tocaria mover al rival y que el ya ha visitado, que jugo.
 *
 * `cubiertas` importa tanto como `huecos`: saber que lo que va a jugar ya lo
 * tienes escrito es media preparacion resuelta, y sin ese numero un panel de
 * huecos parece una lista de fallos en vez de un parte de situacion.
 */
function recorrer(ch, fuentes, mapaRival, miColor, tabla) {
  const huecos = new Map();
  const cubiertas = new Map();
  let posiciones = 0, encuentros = 0;

  const mirar = (epd, fen, ply, salen, linea, apertura, origen) => {
    const suyas = mapaRival.get(epd);
    if (!suyas) return;
    encuentros++;
    for (const [san, dato] of suyas) {
      const destino = salen.has(san) ? cubiertas : huecos;
      const clave = epd + '|' + san;
      const y = destino.get(clave);
      if (y) { y.veces += dato.veces; y.puntos += dato.puntos; continue; }
      destino.set(clave, {
        san, fen, ply,
        veces: dato.veces, puntos: dato.puntos,
        linea: [...linea],
        apertura,
        // Lo que TU tienes escrito ahi. Sin esto el hueco es un reproche sin
        // informacion: lo util es "el juega ...g6 y tu solo tienes ...e6".
        previstas: [...salen].slice(0, 4),
        nPrevistas: salen.size,
        origen,
      });
    }
  };

  for (const f of fuentes) {
    ch.reset();
    let vistos = 0;

    if (f.arbol && fenesDe(f.arbol)) {
      // Fase 33: el mismo recorrido sobre las posiciones ya calculadas. Ni una
      // jugada con chess.js: era la mitad larga de todo el analisis.
      const { san, hijos } = f.arbol;
      const F = fenesDe(f.arbol), E = epdsDe(F);
      const bajar = (nodo, ply, linea, apertura) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        const fen = F[nodo];
        const epd = E[nodo];
        if (tabla[epd]) apertura = tabla[epd];

        posiciones++;
        if (fen.split(' ')[1] !== miColor[0]) {
          mirar(epd, fen, ply, new Set((hijos[nodo] || []).map(h => san[h])),
                linea, apertura, [f.nombre]);
        }
        for (const h of hijos[nodo] || []) {
          vistos++;
          if (F[h] == null) continue;
          linea.push(san[h]);
          bajar(h, ply + 1, linea, apertura);
          linea.pop();
        }
      };
      bajar(0, 0, [], null);

    } else if (f.arbol) {
      const { san, hijos } = f.arbol;
      const bajar = (nodo, ply, linea, apertura) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        const fen = ch.fen();
        const epd = epdDe(fen);
        if (tabla[epd]) apertura = tabla[epd];

        posiciones++;
        // Le toca a el cuando el turno no es de mi color.
        if (fen.split(' ')[1] !== miColor[0]) {
          mirar(epd, fen, ply, new Set((hijos[nodo] || []).map(h => san[h])),
                linea, apertura, [f.nombre]);
        }
        for (const h of hijos[nodo] || []) {
          vistos++;
          let ok = true;
          try { ch.move(san[h]); } catch { ok = false; }
          if (!ok) continue;
          linea.push(san[h]);
          bajar(h, ply + 1, linea, apertura);
          linea.pop();
          ch.undo();
        }
      };
      // Recursivo a proposito: la profundidad esta acotada por PLY_MAX, asi que
      // la pila no puede desbordarse, y con move/undo el tablero se mantiene
      // solo sin copiar posiciones.
      bajar(0, 0, [], null);

    } else if (f.jugadas) {
      const sanes = f.jugadas.split(' ').filter(Boolean).slice(0, PLY_MAX);
      const linea = [];
      let apertura = null;
      for (let i = 0; i <= sanes.length; i++) {
        const fen = ch.fen();
        const epd = epdDe(fen);
        if (tabla[epd]) apertura = tabla[epd];
        posiciones++;
        if (fen.split(' ')[1] !== miColor[0]) {
          mirar(epd, fen, i, new Set(sanes[i] ? [sanes[i]] : []),
                linea, apertura, [f.nombre]);
        }
        if (i === sanes.length) break;
        try { ch.move(sanes[i]); } catch { break; }
        linea.push(sanes[i]);
      }
    }
  }

  return { huecos: [...huecos.values()], cubiertas: [...cubiertas.values()],
           posiciones, encuentros };
}

/* ===========================================================================
   Entrada
   =========================================================================== */
self.onmessage = async (e) => {
  const { partidas, blancas, negras } = e.data;
  // Solo las posiciones de los cursos, sin rival: rival.js lo pide al abrir
  // la pestaña para que el primer analisis no tenga que pagarlas (Fase 33).
  if (e.data.tipo === 'fenes') {
    try {
      const fenes = {};
      for (const f of [...blancas, ...negras]) {
        if (f.arbol && !fenesDe(f.arbol)) fenes[f.id] = fenesDeArbol(Chess, f.arbol);
      }
      postMessage({ ok: true, fenes });
    } catch (err) {
      postMessage({ ok: false, error: String(err?.message || err) });
    }
    return;
  }
  try {
    const tabla = await tablaAperturas();

    // Las posiciones de cada curso, una vez en la vida del arbol (Fase 33).
    // Las que se calculan aqui vuelven al hilo de la interfaz para guardarse
    // con el arbol: el siguiente rival ya no las paga.
    const fenes = {};
    for (const f of [...blancas, ...negras]) {
      if (!f.arbol || fenesDe(f.arbol)) continue;
      f.arbol.fen = fenesDeArbol(Chess, f.arbol);
      fenes[f.id] = f.arbol.fen;
    }

    // Limpiar ANTES de analizar, y devolver las limpias. La pestana se queda
    // con estas para todo lo demas —el libro, la lista de partidas— porque si
    // no, el analisis contaria una cosa y el libro otra a partir de los mismos
    // datos, que es la peor forma posible de tener razon a medias.
    const s = sanearPartidas(Chess, tabla, partidas, PLY_MAX, { conFen: true });
    const resultado = analizar(s.partidas, blancas, negras, tabla);
    // Los FEN de cada partida solo hacian falta aqui dentro: viajar de vuelta
    // seria copiar cuarenta cadenas por partida para nada.
    for (const p of s.partidas) delete p._fen;
    postMessage({ ok: true, partidas: s.partidas, fenes,
                  saneo: { duplicadas: s.duplicadas, convertidas: s.convertidas,
                           ilegales: s.ilegales, reclasificadas: s.reclasificadas },
                  ...resultado });
  } catch (err) {
    postMessage({ ok: false, error: String(err?.message || err) });
  }
};

function analizar(partidas, blancas, negras, tabla) {
  const ch = new Chess();

  /* --- 1. Que juega ------------------------------------------------------ */
  const porBloque = new Map();
  for (const p of partidas) {
    const [b, nombre] = bloqueDe(p.eco);
    const clave = `${p.ladoRival}|${b}`;
    let ag = porBloque.get(clave);
    if (!ag) {
      ag = { side: p.ladoRival, bloque: b, nombre, n: 0, puntos: 0,
             ecos: new Set(), aperturas: new Map() };
      porBloque.set(clave, ag);
    }
    ag.n++;
    ag.puntos += p.puntos;
    if (p.eco) ag.ecos.add(p.eco);
    if (p.apertura) ag.aperturas.set(p.apertura, (ag.aperturas.get(p.apertura) || 0) + 1);
  }

  const bloques = [...porBloque.values()]
    .map(a => ({
      side: a.side, bloque: a.bloque, nombre: a.nombre, n: a.n,
      score: Math.round((a.puntos / a.n) * 100),
      ecos: [...a.ecos].sort(),
      // La apertura concreta mas repetida del bloque: "Siciliana" no dice si
      // hay que preparar Najdorf o Rossolimo, y eso es lo que se prepara.
      principal: [...a.aperturas.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null,
    }))
    .sort((x, y) => y.n - x.n);

  /* --- 2. Cruce en espejo ------------------------------------------------ */
  // Si yo llevo blancas, el lleva negras: su indice de negras es el que hay
  // que cruzar contra mi repertorio de blancas.
  const lados = [
    { miColor: 'white', fuentes: blancas, suLado: 'black' },
    { miColor: 'black', fuentes: negras,  suLado: 'white' },
  ];

  const contra = [];
  let posiciones = 0, encuentros = 0;

  for (const l of lados) {
    if (!l.fuentes.length) continue;
    const suyo = indexarRival(ch, partidas, l.suLado);
    if (!suyo.size) continue;

    const r = recorrer(ch, l.fuentes, suyo, l.miColor, tabla);
    posiciones += r.posiciones;
    encuentros += r.encuentros;

    // Agrupado por bloque de apertura: quince huecos sueltos no se pueden
    // estudiar; tres bloques con sus huecos dentro, si.
    const grupos = new Map();
    const meter = (x, esHueco) => {
      const corte = (x.apertura || '').indexOf('|');
      const eco = corte > 0 ? x.apertura.slice(0, corte) : '';
      const nom = corte > 0 ? x.apertura.slice(corte + 1) : 'Primeras jugadas';
      const [b, nombreB] = bloqueDe(eco);
      const clave = l.miColor + '|' + b;
      let g = grupos.get(clave);
      if (!g) {
        g = { miColor: l.miColor, suLado: l.suLado, bloque: b,
              nombre: b === '??' ? nom : nombreB,
              huecos: [], cubiertas: 0, jugadas: 0 };
        grupos.set(clave, g);
      }
      if (esHueco) g.huecos.push(x); else g.cubiertas += x.veces;
      g.jugadas += x.veces;
    };
    for (const h of r.huecos) meter(h, true);
    for (const c of r.cubiertas) meter(c, false);

    for (const g of grupos.values()) {
      g.huecos.sort((x, y) => y.veces - x.veces || x.ply - y.ply);
      g.huecos = g.huecos.slice(0, 10);
      contra.push(g);
    }
  }

  contra.sort((x, y) => y.jugadas - x.jugadas);

  /* --- 3. Quien se sale de tu teoria en cada partida ---------------------
     El cruce de arriba contesta «que juega el en posiciones que yo tengo».
     Esto contesta otra cosa: partida por partida, quien fue el primero en
     salirse de tu libro. Y la diferencia importa — si se salio su contrario,
     la partida no dice nada de su preparacion, porque contigo esa posicion no
     se habria dado—. Hasta ahora las dos cosas se contaban igual. */
  const salidas = new Array(partidas.length).fill(null);
  for (const l of lados) {
    const s = salidasDeTeoria(Chess, partidas, l.fuentes, l.suLado);
    for (let i = 0; i < s.length; i++) if (s[i]) salidas[i] = s[i];
  }

  /* --- 4. Que abre ------------------------------------------------------- */
  // Las primeras jugadas de TU repertorio de blancas: son las que hay que
  // preguntarle a sus partidas de negras. Que juegue la Siciliana no cambia
  // nada si tu abres 1.d4.
  const misPrimeras = new Set(primerasDelRepertorio(blancas).keys());
  // Se llama `estilo` y no `perfil` para no chocar con el `perfil` del jugador
  // —nombre, titulo, Elo— que la pestaña ya tiene con ese nombre.
  const estilo = perfilDeAperturas(Chess, partidas, misPrimeras, tabla);

  /* --- 5. Sus partidas repartidas por TU libro ---------------------------
     No por el ECO. El ECO clasifica la partida desde fuera y mete en el mismo
     cajon lo que puedes estudiar y lo que no; esto la mete en el grupo de la
     ultima posicion TUYA por la que pasa, asi que cada grupo es una parte de tu
     repertorio y lo que no toca ninguna se aparta en vez de mezclarse. */
  const familias = [];
  // Que partidas suyas pisan tu libro, una por una. La pestaña «Qué juega» lo
  // usa para el filtro «solo lo que yo juego» y para la nota de «N pasan por tu
  // repertorio» de cada bloque de ECO; se calcula aqui porque ya se ha hecho el
  // recorrido y contarlo otra vez en el hilo de la interfaz seria pagarlo dos
  // veces.
  const tocan = new Array(partidas.length).fill(false);
  let sueltas = 0;
  for (const l of lados) {
    if (!l.fuentes.length) continue;
    const mapa = mapaDelRepertorio(ch, l.fuentes, tabla);
    const r = agruparPorRepertorio(ch, partidas, mapa, l.miColor, salidas);
    for (const g of r.grupos) for (const i of g.idx) tocan[i] = true;
    familias.push(...r.grupos);
    sueltas += r.fuera.n;
  }
  familias.sort((a, b) => b.n - a.n);

  return {
    bloques, contra, salidas, estilo, familias, sueltas, tocan,
    resumen: {
      total: partidas.length,
      encuentros,
      huecos: contra.reduce((a, g) => a + g.huecos.length, 0),
      salidas: resumenSalidas(salidas),
    },
  };
}
