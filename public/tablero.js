/* ===========================================================================
   OpeningChessAI — el tablero, como componente reutilizable.

   Lo usan cuatro pantallas con necesidades distintas: el visor de cursos, que
   solo ensena posiciones; el editor de lineas y el entrenador, donde ademas se
   mueven piezas; y el libro del rival, que navega. La diferencia es un
   parametro (`alJugar`), no cuatro tableros: tener cuatro implementaciones del
   mismo tablero garantiza que un dia se arregle un fallo en una y no en las
   otras.

   Se repinta entero en cada jugada. Podria animarse moviendo el nodo de la
   pieza, pero son 64 divs: reconstruirlos cuesta menos de un milisegundo y
   evita toda una clase de errores de estado desincronizado.
   =========================================================================== */

import { insertarPiezas, svgPieza } from './piezas.js';

const LETRAS = 'abcdefgh';
const NOMBRE_PIEZA = { q: 'dama', r: 'torre', b: 'alfil', n: 'caballo' };

export function crearTablero(contenedor, { Chess, alJugar = null, alIlegal = null } = {}) {
  insertarPiezas();

  const ch = new Chess();
  let girado = false;
  let ultima = null;         // {from, to} de la jugada que trajo la posicion
  let origen = null;         // casilla seleccionada
  let destinos = new Map();  // casilla destino -> jugada de chess.js
  let pista = null;          // {from, to} de la pista del entrenador
  let dibujo = null;         // {flechas:[{c,de,a}], marcas:[{c,sq}]} del curso
  let vista = null;          // FEN que se ENSEÑA en vez del real (repaso a ciegas)

  function mostrar(fen, jugada = null) {
    ch.load(fen);
    ultima = jugada;
    origen = null; destinos.clear();
    pista = null;
    dibujo = null;
    pintar();
  }

  /* Flechas y casillas marcadas, las de `[%cal]` y `[%csl]` de un PGN. Como la
     pista, son estado del tablero y no DOM pegado encima: sobreviven a girarlo
     y a seleccionar una pieza. `mostrar()` las borra, asi que quien quiera
     dibujo lo pone despues de cada posicion, y las pantallas que no lo usan
     no tienen que acordarse de limpiarlo. */
  function dibujar(d) { dibujo = d && ((d.flechas?.length) || (d.marcas?.length)) ? d : null; pintar(); }

  function setGirado(v) { girado = !!v; pintar(); }

  /* Repaso a ciegas (Fase 32). Lo que se ve y lo que hay se separan: `ch`
     sigue llevando la posicion REAL —contra ella se resuelven las jugadas—
     y el tablero pinta otra, congelada o vacia. Con vista puesta no se
     enseñan destinos legales, ni ultima jugada, ni pista: cualquiera de las
     tres le diria al usuario donde estan las piezas que tiene que recordar.
     `mostrar()` NO la quita, a proposito: el entrenador actualiza la
     posicion real a cada jugada y la vista tiene que sobrevivir a eso. */
  function setVista(fen) {
    vista = fen || null;
    origen = null; destinos.clear();
    pintar();
  }

  const estaGirado = () => girado;

  /* La pista del entrenador. Se guarda como estado del tablero y no se pega a
     mano sobre el DOM: cualquier repintado —girar, deshacer— borraria las
     clases y la pista desapareceria sin motivo aparente. */
  function marcarPista(from, to) { pista = from && to ? { from, to } : null; pintar(); }
  function limpiarPista() { if (!pista) return; pista = null; pintar(); }

  function pintar() {
    const tabla = vista ? tablaDeFen(vista) : ch.board();
    const ciego = !!vista;
    const filas = girado ? [...tabla].reverse() : tabla;
    let html = '';
    for (let f = 0; f < 8; f++) {
      const cols = girado ? [...filas[f]].reverse() : filas[f];
      for (let c = 0; c < 8; c++) {
        const p = cols[c];
        const fila  = girado ? f + 1 : 8 - f;
        const letra = girado ? LETRAS[7 - c] : LETRAS[c];
        const casilla = p ? p.square : letra + fila;
        const clases = ['casilla', (f + c) % 2 === 0 ? 'clara' : 'oscura'];
        if (!ciego && ultima && (casilla === ultima.from || casilla === ultima.to)) clases.push('marcada');
        if (casilla === origen) clases.push('elegida');
        if (!ciego && destinos.has(casilla)) clases.push(p ? 'captura' : 'destino');
        // La pista va en un elemento propio y no en un pseudoelemento de la
        // casilla: ::before ya lo usan los destinos legales y las capturas, y
        // una casilla puede ser destino y pista a la vez. Con pseudoelementos
        // eso es una carrera de especificidad que se pierde sola al mover una
        // regla de sitio; con un hijo, no hay carrera.
        const marca = !ciego && pista && (casilla === pista.from || casilla === pista.to)
          ? `<i class="pista-marca ${casilla === pista.from ? 'desde' : 'hasta'}"></i>` : '';
        // Coordenadas solo en el borde, como en cualquier tablero de papel:
        // repetirlas en las 64 casillas es ruido, y sin ninguna hay que contar
        // con el dedo para leer una linea escrita en notacion.
        // Casilla marcada del PGN ([%csl]): hijo propio, por lo mismo que la pista.
        const mc = dibujo?.marcas?.find(m => m.sq === casilla);
        const aro = mc ? `<i class="marca-pgn marca-${mc.c}"></i>` : '';
        const coord = (c === 0 ? `<i class="coord-f">${fila}</i>` : '') +
                      (f === 7 ? `<i class="coord-c">${letra}</i>` : '');
        html += `<div class="${clases.join(' ')}" data-sq="${casilla}">` +
                (p ? svgPieza(p.color, p.type) : '') + marca + aro + coord + '</div>';
      }
    }
    contenedor.innerHTML = html + svgFlechas(dibujo?.flechas, girado);
  }

  /* --- Entrada de jugadas -------------------------------------------------- */
  if (alJugar) {
    contenedor.addEventListener('click', (e) => {
      const celda = e.target.closest('.casilla');
      if (!celda) return;
      const sq = celda.dataset.sq;

      // Segundo toque: si es un destino valido, se juega.
      if (origen && destinos.has(sq)) return jugar(destinos.get(sq));

      // Tocar la propia pieza otra vez deselecciona; tocar otra pieza propia
      // cambia la seleccion en un solo toque, que es lo que espera la mano.
      const p = ch.get(sq);
      if (!p || p.color !== ch.turn()) {
        // A ciegas, tocar un destino imposible con una pieza elegida es una
        // jugada ilegal EN LA POSICION REAL, y hay que decirlo: sin destinos
        // pintados, el usuario no tiene otra forma de saber por que no paso
        // nada. Sin vista, es solo deseleccionar, como siempre.
        const ilegal = vista && origen;
        origen = null; destinos.clear(); pintar();
        if (ilegal) alIlegal?.();
        return;
      }

      origen = sq;
      destinos = new Map();
      for (const j of ch.moves({ square: sq, verbose: true })) destinos.set(j.to, j);
      pintar();
    });
  }

  async function jugar(j) {
    let promo = null;
    if (j.promotion) {
      promo = await elegirPromocion(contenedor, ch.turn());
      if (!promo) { origen = null; destinos.clear(); return pintar(); }
    }
    const hecha = ch.move(promo ? { from: j.from, to: j.to, promotion: promo }
                                : { from: j.from, to: j.to });
    origen = null; destinos.clear();
    pista = null;
    ultima = hecha;
    pintar();
    alJugar(hecha, ch.fen());
  }

  return {
    mostrar, setGirado, estaGirado, marcarPista, limpiarPista, dibujar, setVista,
    fen: () => ch.fen(),
    /** Casillas de una jugada en SAN desde la posicion que hay puesta. */
    casillasDe(san) {
      const m = ch.moves({ verbose: true }).find(x => x.san === san);
      return m ? { from: m.from, to: m.to } : null;
    },
  };
}

/* La colocacion de un FEN en la misma forma que `ch.board()` —filas de la 8
   a la 1, casilla o null—, sin pasar por chess.js: el tablero vacio del
   repaso a ciegas no tiene reyes, y chess.js no carga una posicion sin ellos. */
function tablaDeFen(fen) {
  const filas = String(fen).split(' ')[0].split('/');
  return filas.map((fila, f) => {
    const out = [];
    for (const c of fila) {
      if (c >= '1' && c <= '8') for (let i = 0; i < +c; i++) out.push(null);
      else out.push({ type: c.toLowerCase(), color: c === c.toUpperCase() ? 'w' : 'b',
                      square: LETRAS[out.length] + (8 - f) });
    }
    return out;
  });
}

/* Las flechas en un SVG de 8x8 unidades encima de las casillas: una unidad es
   una casilla, asi que no hay que medir nada en pixeles y escalan solas con el
   tablero. Los colores son los estandar de los PGN (G, R, Y, B). */
const COLOR_FLECHA = { G: 'rgba(21,130,40,.85)', R: 'rgba(210,35,45,.85)',
                       Y: 'rgba(235,160,0,.9)', B: 'rgba(40,95,230,.85)' };
function svgFlechas(flechas, girado) {
  if (!flechas?.length) return '';
  const xy = (sq) => {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    return girado ? [7 - f + .5, r + .5] : [f + .5, 7 - r + .5];
  };
  const trazos = flechas.map(({ c, de, a }) => {
    const [ax, ay] = xy(de), [bx, by] = xy(a);
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L;
    const cx = bx - ux * .38, cy = by - uy * .38, col = COLOR_FLECHA[c] || COLOR_FLECHA.G;
    return `<line x1="${ax}" y1="${ay}" x2="${cx}" y2="${cy}" stroke="${col}" stroke-width=".17" stroke-linecap="round"/>` +
      `<polygon points="${bx},${by} ${cx - uy * .27},${cy + ux * .27} ${cx + uy * .27},${cy - ux * .27}" fill="${col}"/>`;
  }).join('');
  return `<svg class="tablero-flechas" viewBox="0 0 8 8" aria-hidden="true">${trazos}</svg>`;
}

/**
 * Eleccion de pieza al coronar.
 *
 * Coronar en dama por defecto sin preguntar seria una jugada distinta de la
 * que el usuario queria, guardada en su repertorio sin que se entere. Pasa
 * poco, pero cuando pasa el error es invisible.
 */
function elegirPromocion(contenedor, color) {
  return new Promise((res) => {
    const caja = document.createElement('div');
    caja.className = 'promocion';
    caja.innerHTML = `<div class="promocion-caja">` +
      ['q', 'r', 'b', 'n'].map(t =>
        `<button data-p="${t}" aria-label="${NOMBRE_PIEZA[t]}">${svgPieza(color, t)}</button>`
      ).join('') +
      `<button class="promocion-cancelar" data-p="">Cancelar</button></div>`;
    caja.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      caja.remove();
      res(b.dataset.p || null);
    });
    contenedor.parentElement.appendChild(caja);
  });
}

/* ===========================================================================
   TABLERO ESTATICO

   Un tablero para MIRAR, no para jugar: devuelve HTML y no un objeto con
   metodos. Existe porque la pestaña Fichas pinta decenas a la vez y el tablero
   de arriba es demasiado caro para eso — cada uno se trae su propia instancia
   de chess.js, engancha eventos y guarda estado que aqui no se usa—.

   Aqui basta con leer el primer campo del FEN, que es la colocacion de las
   piezas, y escupir sesenta y cuatro casillas. Sin coordenadas: a ciento
   veinte puntos de ancho no se leerian, y el que mira una ficha no necesita
   saber que casilla es cual, necesita reconocer la posicion.
   =========================================================================== */
/**
 * @param {string[]} marcadas  casillas a resaltar, en notacion algebraica
 *   («e2», «e4»): el origen y el destino de la ultima jugada. Sin esto, en una
 *   secuencia que avanza sola no hay forma de saber QUE se acaba de mover — la
 *   posicion cambia y el ojo tiene que buscar la diferencia—. Es opcional
 *   porque Fichas pinta decenas de tableros sueltos donde no hay «ultima
 *   jugada» que marcar.
 */
export function tableroEstatico(fen, girado = false, marcadas = []) {
  insertarPiezas();
  const filas = String(fen || '').split(' ')[0].split('/');
  if (filas.length !== 8) return '';

  // De la notacion comprimida a 64 casillas: los digitos son huecos seguidos.
  const casillas = [];
  // Y en paralelo, el nombre de cada casilla. Se construye aqui y no con
  // aritmetica al pintar porque asi el volteo es UNA operacion —darle la vuelta
  // a los dos arrays— en vez de dos formulas que hay que mantener de acuerdo.
  const nombres = [];
  const LETRAS = 'abcdefgh';
  for (const fila of filas) {
    for (const c of fila) {
      if (c >= '1' && c <= '8') for (let i = 0; i < +c; i++) casillas.push(null);
      else casillas.push(c);
    }
  }
  if (casillas.length !== 64) return '';
  for (let i = 0; i < 64; i++) nombres.push(LETRAS[i & 7] + (8 - (i >> 3)));
  if (girado) { casillas.reverse(); nombres.reverse(); }

  const marcar = new Set(marcadas || []);
  let html = '';
  for (let i = 0; i < 64; i++) {
    const p = casillas[i];
    const clara = ((i >> 3) + (i & 7)) % 2 === 0;
    html += `<div class="casilla ${clara ? 'clara' : 'oscura'}${
              marcar.has(nombres[i]) ? ' marcada' : ''}">` +
            (p ? svgPieza(p === p.toUpperCase() ? 'w' : 'b', p.toLowerCase()) : '') +
            `</div>`;
  }
  return html;
}
