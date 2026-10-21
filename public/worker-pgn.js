/* ===========================================================================
   OpeningChessAI — Web Worker: PGN -> arbol de aperturas.

   Vive en un worker porque parsear un repertorio de miles de partidas son
   segundos de CPU, y hacerlo en el hilo principal congela el scroll y los
   toques. La regla del proyecto es que el movil calcula, pero nunca en el
   hilo que pinta.

   Por que un parser propio y no `chess.js.loadPgn()`:
   loadPgn se queda con la linea principal. Un PGN de repertorio es
   practicamente todo variantes — "si juega esto, yo esto; si juega lo otro,
   esto" — asi que quedarse con la principal tira justo el contenido. Aqui se
   parsea el movetext entero, con variantes anidadas, comentarios y NAGs, y
   chess.js se usa solo para lo que hace mejor que nadie: validar cada SAN y
   llevar la posicion.

   El arbol se devuelve como un array plano de nodos y no como objetos
   anidados: se serializa a IndexedDB sin recursion, se recorre por indice, y
   un arbol de 60.000 nodos no revienta la pila al guardarlo.
   =========================================================================== */

import { Chess } from './vendor/chess.js';

/* --- Separar el fichero en partidas --------------------------------------
   Una partida empieza donde aparece una cabecera [Tag "..."] despues de que
   la anterior ya tuviera movimientos. Partir por lineas en blanco no vale:
   hay PGN sin linea en blanco entre cabeceras y jugadas, y comentarios de
   varias lineas que traen las suyas propias. */
function separarPartidas(texto) {
  const partidas = [];
  let cab = {}, mov = [], vistoMov = false;

  const cerrar = () => {
    if (Object.keys(cab).length || mov.length) {
      partidas.push({ cabeceras: cab, movetext: mov.join('\n') });
    }
    cab = {}; mov = []; vistoMov = false;
  };

  for (const linea of texto.split(/\r?\n/)) {
    const l = linea.trim();
    const m = /^\[(\w+)\s+"([\s\S]*)"\]$/.exec(l);
    if (m) {
      if (vistoMov) cerrar();
      cab[m[1]] = m[2];
    } else if (l) {
      vistoMov = true;
      mov.push(l);
    } else if (vistoMov) {
      mov.push('');
    }
  }
  cerrar();
  return partidas.filter(p => p.movetext.trim());
}

/* --- Tokenizar el movetext ------------------------------------------------
   Se recorre caracter a caracter en vez de con expresiones regulares porque
   los comentarios pueden contener parentesis y las variantes pueden contener
   comentarios: eso no es un lenguaje regular y una regex acaba fallando en el
   caso raro justo del fichero de alguien. */
const RESULTADOS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

function tokenizar(mt) {
  const t = [];
  let i = 0;
  const n = mt.length;

  while (i < n) {
    const c = mt[i];

    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') { i++; continue; }

    if (c === '{') {                       // comentario entre llaves
      const fin = mt.indexOf('}', i + 1);
      const cuerpo = fin === -1 ? mt.slice(i + 1) : mt.slice(i + 1, fin);
      t.push({ t: 'com', v: cuerpo.replace(/\s+/g, ' ').trim() });
      i = fin === -1 ? n : fin + 1;
      continue;
    }

    if (c === ';') {                       // comentario hasta fin de linea
      const fin = mt.indexOf('\n', i);
      t.push({ t: 'com', v: mt.slice(i + 1, fin === -1 ? n : fin).trim() });
      i = fin === -1 ? n : fin + 1;
      continue;
    }

    if (c === '(') { t.push({ t: 'abre' }); i++; continue; }
    if (c === ')') { t.push({ t: 'cierra' }); i++; continue; }

    if (c === '$') {                       // NAG numerico
      let j = i + 1;
      while (j < n && mt[j] >= '0' && mt[j] <= '9') j++;
      t.push({ t: 'nag', v: mt.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '<' || c === '>') { i++; continue; }   // reservados por el estandar

    // Palabra suelta: numero de jugada, SAN o resultado.
    let j = i;
    while (j < n && !' \n\r\t{}();$'.includes(mt[j])) j++;
    const p = mt.slice(i, j);
    i = j;
    if (!p) continue;

    if (RESULTADOS.has(p)) { t.push({ t: 'fin' }); continue; }
    if (/^\d+\.*$/.test(p)) continue;                 // "12." o "12..."
    if (p === '...' || p === '.') continue;

    // "12.e4" sin espacio: el numero va pegado a la jugada.
    const pegado = /^\d+\.+(.+)$/.exec(p);
    t.push({ t: 'san', v: pegado ? pegado[1] : p });
  }
  return t;
}

/* --- Limpiar el SAN -------------------------------------------------------
   Los sufijos de anotacion (!, ?, !?, ...) forman parte del PGN pero no de la
   jugada. chess.js los rechaza en modo estricto y, peor, en modo laxo puede
   interpretarlos mal. Se separan aqui y se guardan como anotacion del nodo. */
function limpiarSan(san) {
  const m = /^(.*?)([!?]{1,2})$/.exec(san);
  if (!m) return { san, marca: null };
  return { san: m[1], marca: m[2] };
}

/* --- Construir el arbol ---------------------------------------------------
   Los nodos se fusionan por (padre, SAN): si dos partidas del mismo fichero
   empiezan igual, comparten camino y `f` cuenta cuantas pasan por ahi. Esa
   frecuencia es la que despues ordena el entrenador — se entrena mas lo que
   mas aparece.

   No se fusiona por posicion (transposiciones): dos caminos distintos a la
   misma posicion quedan como ramas distintas. Fusionarlos convertiria el
   arbol en un grafo, y navegar "atras" dejaria de tener una respuesta unica,
   que es justo lo que hace comodo el visor.  */
/* El EPD de la posicion inicial: FEN sin los contadores de jugada. Un curso
   que declare exactamente esta posicion en su [FEN] es un curso normal. */
const EPD_INICIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

const LIMITE_NODOS = 400000;

/* VERSION DEL ARBOL. Sube cuando el arbol gana datos que un arbol viejo, ya
   guardado en IndexedDB, no tiene. Quien necesite esos datos (lineas.js)
   compara `arbol.v` y, si se queda corto, vuelve a parsear ESE curso; los
   demas modulos siguen leyendo el arbol viejo sin enterarse, porque todo lo
   que habia sigue estando donde estaba.
     1 (sin campo) — san, padre, hijos, frec, com, nag.
     2 — `com` sin los comandos [%...] y con los comentarios de un mismo nodo
         juntados; `cal` y `csl` (flechas y casillas marcadas, lo que exportan
         las plataformas habituales); `cap` y `capitulos` (de que capitulo sale cada
         nodo, para poner nombre a las variantes). */
const VERSION_ARBOL = 2;   // la misma cifra vive en lineas.js: cambiarlas juntas

/* --- Comentarios: texto, flechas y marcas ---------------------------------
   `{[%cal Gb4c3,Re4d5] La Winawer}` es a la vez un texto para leer y un dibujo
   para el tablero. Se separan aqui y no al pintar: el comando entre corchetes
   no es para leerlo, y un visor que no sepa de flechas enseñaria
   «[%cal Gb4c3]» en mitad de la frase. De paso se tiran [%clk] y [%eval]
   de las partidas de Lichess, que tampoco son para leer. */
const RX_CAL = /\[%cal\s+([^\]]+)\]/g;
const RX_CSL = /\[%csl\s+([^\]]+)\]/g;
function partirComentario(c) {
  const cal = [], csl = [];
  c.replace(RX_CAL, (_, x) => {
    for (let a of x.split(',')) {
      a = a.trim();
      if (/^[GRYB][a-h][1-8][a-h][1-8]$/.test(a)) cal.push(a);
    }
  });
  c.replace(RX_CSL, (_, x) => {
    for (let a of x.split(',')) {
      a = a.trim();
      if (/^[GRYB][a-h][1-8]$/.test(a)) csl.push(a);
    }
  });
  const texto = c.replace(/\[%[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  return { texto, cal, csl };
}

/* El nombre de cada capitulo sale de la cabecera que MAS cambia entre las
   partidas del fichero. Unos exportadores ponen el capitulo en Event, otros
   en White segun como se exporte, y otros en Black. La que es
   igual en todas («Curso», «?») no nombra nada. */
function campoDeCapitulo(partidas) {
  let mejor = 'Event', max = -1;
  for (const k of ['Event', 'White', 'Black']) {
    const n = new Set(partidas.map(p => p.cabeceras[k] || '')).size;
    if (n > max) { max = n; mejor = k; }
  }
  return mejor;
}

function construir(partidas, avisar) {
  // Arrays paralelos en vez de objetos: un array de 60.000 objetos con seis
  // campos cada uno pesa varias veces mas en memoria y al serializar.
  const san = [null], padre = [-1], hijos = [[]], frec = [0];
  const com = new Map(), nag = new Map();
  const cal = new Map(), csl = new Map();   // nodo -> ['Gb4c3', ...]
  const cap = [-1];                         // capitulo que CREO cada nodo
  const capitulos = [];
  const campo = campoDeCapitulo(partidas);

  const ch = new Chess();
  let errores = 0, truncado = false;
  const ultimoError = { texto: null };
  let desdePosicion = 0;   // capitulos de [FEN] que no se han podido injertar
  let injertados = 0;      // los que si

  /* EL INJERTO DE CAPITULOS QUE EMPIEZAN A MITAD DE PARTIDA.
   *
   * Un curso exportado por capitulos trae cada uno con su [FEN]. Colgarlos de
   * la raiz corrompe el arbol —de ahi salia un «1.Cxd4» como primera jugada—,
   * pero tirarlos deja el curso en la cuarta parte, porque en esos cursos la
   * mayoria de los capitulos son asi.
   *
   * La salida: casi siempre esa posicion YA ESTA en el arbol, puesta por otro
   * capitulo que si venia desde la jugada 1. Entonces el capitulo no empieza en
   * ninguna parte: continua ahi. Se indexa la posicion de cada nodo y se busca.
   *
   * El indice solo se construye si hace falta —si algun capitulo trae [FEN]—,
   * porque son una cadena por nodo y un curso normal no lo necesita para nada.
   */
  const epd4 = (fen) => String(fen || '').split(' ').slice(0, 4).join(' ');
  const esDePosicion = (p) => {
    const f = p.cabeceras.FEN;
    return !!f && epd4(f) !== EPD_INICIAL;
  };
  const hayCapitulos = partidas.some(esDePosicion);
  const nodoDeEpd = hayCapitulos ? new Map([[EPD_INICIAL, 0]]) : null;

  // Primero las que empiezan por el principio: son las que crean el arbol sobre
  // el que se injertan las demas. Dentro de cada grupo se respeta el orden del
  // fichero, que es el que decide las frecuencias.
  const orden = hayCapitulos
    ? [...partidas.keys()].sort((a, b) => esDePosicion(partidas[a]) - esDePosicion(partidas[b]))
    : [...partidas.keys()];

  orden.forEach((iPartida, idx) => {
    const partida = partidas[iPartida];
    if (truncado) return;
    if (idx % 200 === 0) avisar(idx);
    const nomCap = partida.cabeceras[campo];
    const iCap = capitulos.push(nomCap && nomCap !== '?' ? nomCap : `Capítulo ${iPartida + 1}`) - 1;

    /* UNA PARTIDA QUE EMPIEZA DESDE UNA POSICION DADA NO ENTRA EN EL ARBOL.
     *
     * Esto costo un curso entero. Los cursos exportados por capitulos —«French
     * Defense According to Moroni», por ejemplo— traen cada capitulo con su
     * cabecera [FEN] y su movetext empezando en mitad de la partida. El codigo
     * cargaba ese FEN en el tablero pero seguia colgando las jugadas del NODO
     * RAIZ, asi que el `Cxd4` de un capitulo de la Tarrasch aparecia como
     * primera jugada de la partida, al lado de `1.e4`. Las jugadas eran legales
     * —desde SU posicion— y por eso no saltaba ninguna alarma: el arbol salia
     * corrupto en silencio, que es la peor forma de salir mal.
     *
     * Y no se puede arreglar colgandolas de otro sitio: un FEN dice donde
     * estas, no como has llegado, y este arbol vive de que toda linea se pueda
     * jugar desde la jugada 1. Eso es lo que entrena el entrenador y lo que
     * recorre el cruce en espejo del rival.
     *
     * Asi que se descartan, PERO SE CUENTAN Y SE DICEN. Descartar en silencio
     * es como se pierde la confianza en un numero.
     */
    const fenInicial = partida.cabeceras.FEN;
    let arranque = 0;
    if (esDePosicion(partida)) {
      try { ch.load(fenInicial); } catch { desdePosicion++; return; }
      // Se busca con el FEN que devuelve chess.js y no con el de la cabecera:
      // muchos exportadores ponen la casilla al paso tras cualquier avance de
      // dos («... c6 0 5») y chess.js solo la escribe si la captura es legal.
      // Comparando el de la cabecera, ese capitulo no encontraba nunca su
      // sitio aunque la posicion fuera identica.
      const nodo = nodoDeEpd.get(epd4(ch.fen()));
      // Sin sitio donde injertarlo no hay nada que hacer: un FEN dice donde
      // estas, no como has llegado, y este arbol vive de que toda linea se
      // pueda jugar desde la jugada 1 —es lo que entrena el entrenador y lo
      // que recorre el cruce en espejo del rival—.
      if (nodo === undefined) { desdePosicion++; return; }
      arranque = nodo;
      injertados++;
    } else {
      ch.reset();
    }

    const tokens = tokenizar(partida.movetext);
    let actual = arranque;     // nodo en el que estamos
    // -1 tambien en un injerto: para retroceder haria falta la posicion del
    // nodo padre, que no se guarda. Solo afecta a una variante abierta en la
    // PRIMERA jugada del capitulo, que se leeria como continuacion; el resto
    // del capitulo va bien y perderlo entero seria mucho peor.
    let padreDe = -1;          // nodo anterior a `actual`, para abrir variantes
    let fenPadre = ch.fen();   // posicion ANTES de la ultima jugada
    const pila = [];           // un marco por cada '(' abierto
    frec[0]++;

    for (const tk of tokens) {
      if (tk.t === 'fin') break;

      if (tk.t === 'abre') {
        // Una variante es alternativa a la ULTIMA jugada, no continuacion:
        // hay que retroceder un nodo antes de leerla.
        //
        // El retroceso se hace cargando la posicion guardada, NO con undo():
        // al cerrar una variante se hace load(), y load() borra el historial
        // de chess.js, con lo que el siguiente undo() no deshace nada. El
        // arbol retrocedia y la posicion no, y a partir de ahi las jugadas se
        // aplicaban sobre un tablero equivocado: lineas de 280 plies y SAN
        // legales rechazados como ilegales.
        pila.push({ actual, padreDe, fenPadre, fen: ch.fen() });
        if (padreDe >= 0) {
          actual = padreDe;
          try { ch.load(fenPadre); } catch { /* no deberia pasar: viene de fen() */ }
        }
        continue;
      }

      if (tk.t === 'cierra') {
        const v = pila.pop();
        if (!v) continue;
        actual = v.actual; padreDe = v.padreDe; fenPadre = v.fenPadre;
        try { ch.load(v.fen); } catch { /* fen imposible: se sigue como se pueda */ }
        continue;
      }

      if (tk.t === 'com') {
        if (!tk.v) continue;
        const { texto, cal: fl, csl: ma } = partirComentario(tk.v);
        // Se JUNTAN los comentarios de un nodo, pero sin repetir: un curso por
        // capitulos repite la linea principal —con sus comentarios— en cada
        // capitulo, y sumarlos tal cual escribiria el mismo parrafo diez veces.
        if (texto) {
          const ya = com.get(actual);
          if (!ya) com.set(actual, texto);
          else if (!ya.includes(texto)) com.set(actual, ya + ' ' + texto);
        }
        if (fl.length) {
          const ya = cal.get(actual) || [];
          for (const a of fl) if (!ya.includes(a)) ya.push(a);
          cal.set(actual, ya);
        }
        if (ma.length) {
          const ya = csl.get(actual) || [];
          for (const a of ma) if (!ya.includes(a)) ya.push(a);
          csl.set(actual, ya);
        }
        continue;
      }

      if (tk.t === 'nag') { if (!nag.has(actual)) nag.set(actual, tk.v); continue; }

      // --- jugada ---
      const { san: limpio, marca } = limpiarSan(tk.v);
      const fenAntes = ch.fen();
      let jugada = null;
      try { jugada = ch.move(limpio); } catch { jugada = null; }
      if (!jugada) {
        errores++;
        if (!ultimoError.texto) ultimoError.texto = tk.v;
        // Una jugada ilegal invalida todo lo que viene detras en esta rama:
        // seguir aplicando SAN sobre una posicion equivocada produce basura
        // silenciosa, que es peor que perder la rama.
        break;
      }

      const sanReal = jugada.san;
      let hijo = hijos[actual].find(h => san[h] === sanReal);
      if (hijo === undefined) {
        if (san.length >= LIMITE_NODOS) { truncado = true; break; }
        hijo = san.length;
        san.push(sanReal); padre.push(actual); hijos.push([]); frec.push(0); cap.push(iCap);
        hijos[actual].push(hijo);
      }
      frec[hijo]++;
      // La posicion de este nodo, para que un capitulo que empiece justo aqui
      // sepa engancharse. Se queda el PRIMERO que la alcanza: con
      // transposiciones hay varios caminos y cualquiera de ellos es valido.
      if (nodoDeEpd && !nodoDeEpd.has(epd4(ch.fen()))) nodoDeEpd.set(epd4(ch.fen()), hijo);
      if (marca && !nag.has(hijo)) nag.set(hijo, marca);
      padreDe = actual;
      fenPadre = fenAntes;
      actual = hijo;
    }
  });

  return {
    v: VERSION_ARBOL,
    san, padre, hijos, frec,
    com: [...com], nag: [...nag],
    cal: [...cal], csl: [...csl],
    cap, capitulos,
    stats: {
      partidas: partidas.length,
      nodos: san.length - 1,
      errores,
      desdePosicion,
      injertados,
      ejemploError: ultimoError.texto,
      truncado,
    },
  };
}

/* --- Mensajes ------------------------------------------------------------ */
self.onmessage = (e) => {
  const { tipo, pgn } = e.data || {};
  if (tipo !== 'parsear') return;
  try {
    const partidas = separarPartidas(pgn);
    if (!partidas.length) throw new Error('el fichero no contiene ninguna partida');
    const arbol = construir(partidas, (i) =>
      self.postMessage({ tipo: 'progreso', hechas: i, total: partidas.length }));
    self.postMessage({ tipo: 'listo', arbol });
  } catch (err) {
    self.postMessage({ tipo: 'error', mensaje: String(err?.message || err) });
  }
};
