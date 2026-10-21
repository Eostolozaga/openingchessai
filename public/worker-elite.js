/* ===========================================================================
   OpeningChessAI — cruce de las partidas de elite contra tu repertorio.

   La pregunta es "de todas estas partidas de 2500 para arriba, ¿cuales pasan
   por lo que yo juego?". Se contesta al reves de como parece: no se busca cada
   posicion del repertorio en las partidas —serian miles de busquedas— sino que
   se mete el repertorio entero en un conjunto de posiciones y luego se
   reproduce cada partida una vez, mirando si cae dentro.

   Un conjunto de cadenas y una comprobacion por jugada. Con seis mil partidas
   y cuarenta jugadas son doscientas cuarenta mil comprobaciones, que en un
   movil son unas decimas.

   Indexar por posicion y no por camino regala las transposiciones, que es el
   punto entero: la partida que llega a tu Najdorf por 2.Cf3 en vez de por
   2.Cc3 te interesa igual.

   DOS PROFUNDIDADES, UNA POR COLOR. La misma partida vale distinto segun a que
   repertorio tuyo se parezca: la que recorre tus lineas de blancas es un modelo
   de como jugar TU con blancas, y la que recorre las de negras, al reves. Antes
   salian revueltas y habia que mirar cada una para saber cual era cual.

   LO QUE SE DEVUELVE ES LA PROFUNDIDAD, no un si o un no. Toda partida pasa por
   la posicion inicial, asi que "coincide" no significa nada; lo que ordena es
   HASTA DONDE sigue dentro de tu libro. Una que se sale en la jugada 4 es
   ruido, una que aguanta hasta la 15 es la partida modelo que buscabas.
   =========================================================================== */

import { Chess } from './vendor/chess.js';
import { epdDe, tablaAperturas } from './aperturas.js';
import { bloqueDe } from './bloques.js';

/* Veinte jugadas, como el resto. Mas alla ya no es apertura y la coincidencia
   deja de significar que jugais lo mismo. */
const PLY_MAX = 40;
/* Techo del recorrido del repertorio, como en el cruce de rivales. */
const MAX_NODOS = 120000;
/* CUANDO UNA PARTIDA CUENTA. Dos formas, y la segunda es la que importa.

   1. Se mete ocho medias jugadas en tu libro. Ese era el criterio unico, y
      sirve mientras tengas lineas largas.

   2. LLEGA HASTA DONDE LLEGA TU LIBRO. Una partida no puede seguir tu
      repertorio mas alla de donde tu repertorio termina, asi que exigirle
      profundidad a un libro corto es exigir algo imposible.

   El segundo caso no es una excepcion rara: es lo normal con negras. «Juego la
   Francesa» son DOS medias jugadas —1.e4 e6— y ahi se acaba tu decision; lo
   que se ramifica despues es lo que elige el blanco: d4, d3, Cf3, Cc3. Querer
   ver partidas de elite de todas esas es exactamente para lo que sirve esto, y
   con el umbral fijo salian cero.

   La diferencia con «la partida se salio de mi libro» es de quien se queda
   corto. Si la posicion donde acabo la coincidencia TIENE continuaciones
   escritas y la partida jugo otra, la partida se fue por su cuenta y hace falta
   profundidad. Si NO tiene ninguna —es una hoja—, el que se acaba es tu libro,
   y la partida lo ha recorrido entero. */
const MINIMO = 8;
/* Suelo absoluto: dos medias jugadas. Menos que eso es no haber dicho nada —un
   libro de «1.e4» cruzaria con media base—. */
const HOJA_MIN = 2;
/** Hasta donde llega el libro de ese color, para poder decirlo. */
const hondo = (mapa) => { let h = 0; for (const p of mapa.values()) if (p > h) h = p; return h; };

/* El worker vive entre dos mensajes y no muere en el primero.
   Hace falta preguntarle DOS cosas en orden: primero que bloques de apertura
   toca el repertorio —para no bajarse los diecinueve— y despues, ya con esos
   ficheros en la mano, cuales de sus partidas caen dentro. Entre las dos hay
   una descarga, que el worker no puede hacer.

   Mantenerlo vivo ahorra reconstruir el conjunto de posiciones del repertorio,
   que es la parte cara: recorrer un arbol de cursos entero. */
let ch = null;
let mias = null;          // las dos juntas, para clasificar por bloque
let miasB = null;         // solo tu repertorio de blancas
let miasN = null;         // solo el de negras

self.onmessage = async (e) => {
  try {
    if (e.data.tipo === 'bloques') {
      ch = new Chess();
      const tabla = await tablaAperturas();
      // Las dos listas llegan YA SEPARADAS y no se filtran aqui por `color`.
      //
      // Filtrar por `x.color === 'black'` parecia equivalente y no lo es: quien
      // reparte los cursos en blancas y negras es `fuentesDelRepertorio`, y lo
      // hace con `c.color === 'white' ? blancas : negras`. Cualquier valor que
      // no sea exactamente 'white' cae en negras alli y se caia de MI filtro
      // aqui, dejando el repertorio de negras vacio sin que nada fallara.
      // Dos formas de partir la misma lista son una de mas.
      miasB = posicionesDelRepertorio(ch, e.data.blancas || []);
      miasN = posicionesDelRepertorio(ch, e.data.negras || []);
      // La union, para decidir que bloques bajarse: eso no depende del color.
      mias = new Map(miasB);
      for (const [epd, ply] of miasN) {
        const y = mias.get(epd);
        if (y === undefined || ply < y) mias.set(epd, ply);
      }
      postMessage({ ok: true, tipo: 'bloques', ...bloquesDelRepertorio(tabla) });
      return;
    }
    postMessage({ ok: true, tipo: 'cruce', ...cruzar(e.data.juegos) });
  } catch (err) {
    postMessage({ ok: false, error: String(err?.message || err) });
  }
};

/* Profundidad minima para que el ECO de una posicion signifique algo, y tope de
   bloques a bajar.

   Sin el minimo, 1.e4 sale como B00 y 1.d4 como A40, asi que CUALQUIER
   repertorio pedia esos bloques y se bajaba media Alekhine para nada. A partir
   de la tercera jugada el ECO ya dice de que se esta hablando.

   El tope existe porque cada bloque es medio mega: un repertorio muy ancho
   podria pedir quince. Cuando recorta, lo dice —recortar en silencio deja al
   usuario buscando partidas que nunca se bajaron—.

   Y EL TOPE ES POR COLOR, no en total. Con un tope global, un repertorio de
   blancas grande —tres cursos de Siciliana, Espanola y Gambito de dama— se
   comia los seis huecos y el unico bloque de negras se quedaba fuera. La
   pestana de negras salia vacia y no habia forma de saber por que: las
   partidas estaban subidas, simplemente nunca se pidieron.

   Cuatro y cuatro: ocho ficheros son unos cuatro megas, se bajan una vez y se
   quedan guardados. */
const PLY_ECO = 6;
/* Dos, no tres. «1.e4 e6» son exactamente dos medias jugadas y la tabla ya lo
   llama Francesa; con tres se quedaba fuera el caso que hay que cubrir. El
   peligro estaba en uno —«1.e4» es B00 y se traeria media base— y en dos no
   existe: a partir de la primera jugada de las negras el ECO ya dice de que
   apertura se habla. */
const PLY_ECO_MIN = 2;
const POR_COLOR = 4;

/**
 * Que familias de apertura toca el repertorio.
 *
 * Se saca de las MISMAS posiciones que ya se han recorrido, mirando cuales
 * tienen nombre en la tabla de aperturas y quedandose con su bloque. Asi no
 * hace falta volver a bajar el arbol, y sale la lista corta —tres o cuatro
 * bloques— que decide que ficheros se baja la app.
 */
function bloquesDelRepertorio(tabla) {
  /* Con `desde` = profundidad minima para fiarse del ECO de una posicion.
     Se prueba primero con 6 y, si de ese color no sale NINGUN bloque, se baja
     a 3: mas vale una clasificacion algo generica que una pestaña vacia.

     Es justo el caso de una linea corta —«French Defense», cuatro medias
     jugadas—: ninguna de sus posiciones llega a la sexta, asi que con el
     umbral fijo no se pedia ni un bloque de negras y no habia forma de saberlo
     desde fuera. */
  const contar = (mapa, desde) => {
    const cuenta = new Map();
    for (const [epd, ply] of mapa) {
      if (ply < desde) continue;
      const v = tabla[epd];
      if (!v) continue;
      const b = bloqueDe(v.slice(0, v.indexOf('|')))[0];
      if (b === '??') continue;
      cuenta.set(b, (cuenta.get(b) || 0) + 1);
    }
    // Ordenados por cuanto repertorio hay en cada uno: al recortar se cae lo
    // que menos se juega.
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  };
  /* Los bien clasificados primero y los de las lineas cortas DETRAS, no en vez
     de. Probar el umbral bajo solo cuando el alto no da nada no vale: basta con
     tener una linea larga de ese color para que las cortas —que son las que
     necesitan el respaldo— se queden fuera calladas. Fue exactamente lo que
     paso con una Francesa de cuatro medias jugadas conviviendo con una
     Caro-Kann de diez. */
  const conRespaldo = (mapa) => {
    const altos = contar(mapa, PLY_ECO);
    const bajos = contar(mapa, PLY_ECO_MIN).filter(b => !altos.includes(b));
    return { bloques: [...altos, ...bajos], relajado: !!bajos.length };
  };

  const rB = conRespaldo(miasB), rN = conRespaldo(miasN);
  const deB = rB.bloques, deN = rN.bloques;
  const pedidos = new Set([...deB.slice(0, POR_COLOR), ...deN.slice(0, POR_COLOR)]);
  const fuera = [...deB.slice(POR_COLOR), ...deN.slice(POR_COLOR)]
    .filter(b => !pedidos.has(b));

  return {
    bloques: [...pedidos],
    descartados: [...new Set(fuera)],
    posiciones: mias.size,
    // Cuantas fuentes hay de cada color y que bloques toca cada uno: la
    // pantalla lo necesita para poder decir «no tienes nada con negras» en vez
    // de enseñar una pestaña vacia sin explicacion.
    porColor: { white: deB.slice(0, POR_COLOR), black: deN.slice(0, POR_COLOR) },
    sinBlancas: !miasB.size, sinNegras: !miasN.size,
    // Los numeros de verdad, para poder enseñarlos. Un panel que dice «0
    // partidas de negras» sin decir cuanto repertorio de negras ha mirado no
    // se puede depurar ni desde dentro ni desde fuera.
    diag: { posB: miasB.size, posN: miasN.size,
            bloquesB: deB, bloquesN: deN,
            hondoB: hondo(miasB), hondoN: hondo(miasN),
            relajadoB: rB.relajado, relajadoN: rN.relajado },
  };
}

function cruzar(juegos) {
  const vale = (h, hoja) => h >= MINIMO || (hoja && h >= HOJA_MIN);
  const fuera = [];
  for (let k = 0; k < juegos.length; k++) {
    const sanes = String(juegos[k][1] || '').split(' ');
    ch.reset();
    // Dos profundidades a la vez, una por color. Una misma partida puede
    // recorrer los dos repertorios —pasa cuando juegas la misma estructura con
    // los dos colores— y entonces vale para las dos pestañas: esconderla en una
    // seria perder material por una decision de la app, no del usuario.
    let hb = 0, hn = 0, hojaB = false, hojaN = false;
    for (let ply = 0; ply < sanes.length && ply < PLY_MAX; ply++) {
      try { if (!ch.move(sanes[ply])) break; } catch { break; }
      const epd = epdDe(ch.fen());
      // Se guarda si la ULTIMA posicion coincidente era final de tu libro. Si
      // luego la partida vuelve a entrar por transposicion, se sobreescribe, y
      // esta bien: lo que decide es donde acaba la coincidencia.
      if (miasB.has(epd)) { hb = ply + 1; hojaB = !miasB.internos.has(epd); }
      if (miasN.has(epd)) { hn = ply + 1; hojaN = !miasN.internos.has(epd); }
      // Si ya lleva diez medias jugadas fuera de LOS DOS, no va a volver:
      // seguir reproduciendo es tiempo tirado. Diez y no una porque una
      // transposicion puede tardar un par de jugadas en cerrarse.
      const hasta = Math.max(hb, hn);
      if (hasta && ply - hasta > 10) break;
    }
    const okB = vale(hb, hojaB), okN = vale(hn, hojaN);
    if (okB || okN) fuera.push([k, Math.max(hb, hn), okB ? hb : 0, okN ? hn : 0]);
  }

  // Primero las que mas se meten en tu repertorio y, a igual profundidad, las
  // de mas Elo. El array ya venia ordenado por Elo desde el volcado, asi que
  // basta con que la ordenacion sea estable —lo es en todos los navegadores
  // desde 2019— para que el desempate salga solo.
  fuera.sort((a, b) => b[1] - a[1]);
  // Los umbrales usados viajan con el resultado: la pantalla tiene que poder
  // decir «te sigue hasta la jugada 2 porque tu libro llega hasta la 2».
  return { encontradas: fuera };
}

/**
 * Todas las posiciones por las que pasa el repertorio, en un conjunto.
 *
 * No distingue color a proposito. Una partida de elite que recorre tu linea de
 * blancas te vale aunque el que lleva blancas alli no seas tu: lo que se busca
 * es material sobre esa posicion, no una atribucion.
 */
function posicionesDelRepertorio(ch, fuentes) {
  // Un Map y no un Set: hace falta saber a que profundidad aparece cada
  // posicion —la MENOR, si aparece por varios caminos— para no clasificar el
  // repertorio entero como B00 por pasar todos por 1.e4.
  const mias = new Map();
  // Y aparte, cuales tienen continuacion escrita. Una posicion que es hoja en
  // un curso y nudo en otro NO es hoja: tu libro sigue, solo que por otro
  // sitio. Por eso se apuntan los nudos y las hojas se deducen al final.
  const internos = new Set();
  let vistos = 0;
  const anotar = (ply, tieneHijos) => {
    const epd = epdDe(ch.fen());
    const y = mias.get(epd);
    if (y === undefined || ply < y) mias.set(epd, ply);
    if (tieneHijos) internos.add(epd);
  };

  for (const f of fuentes || []) {
    ch.reset();
    if (f.arbol) {
      const { san, hijos } = f.arbol;
      const bajar = (nodo, ply) => {
        if (ply >= PLY_MAX || vistos > MAX_NODOS) return;
        anotar(ply, !!(hijos[nodo] || []).length);
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
      for (let i = 0; i <= sanes.length; i++) {
        anotar(i, i < sanes.length);
        if (i === sanes.length) break;
        try { ch.move(sanes[i]); } catch { break; }
      }
    }
  }
  mias.internos = internos;
  return mias;
}
