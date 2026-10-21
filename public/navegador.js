/* ===========================================================================
   OpeningChessAI — la mecanica de navegar una linea, compartida.

   Hay dos pantallas que hacen exactamente lo mismo con el tablero: el libro del
   rival y el explorador de maestros. Un tablero, una linea de jugadas, cuatro
   flechas, la lista de jugadas pulsable, y debajo un panel que cambia segun la
   posicion. Lo unico distinto es DE DONDE salen los datos del panel.

   Se escribio dos veces y duro poco: el mismo comentario que hay en tablero.js
   —tener dos implementaciones garantiza que un dia se arregle un fallo en una y
   no en la otra— vale igual aqui, y el error de un ply en la lista de jugadas
   es justo la clase de fallo que se arregla en un sitio y sobrevive en el otro.

   El estado es un array de SAN y un indice. Todo lo demas se deriva de ahi en
   cada repintado. Es mas trabajo por jugada y a cambio no existe la clase de
   fallo en la que el tablero ensena una posicion y el panel las cifras de otra.

   Quien lo usa pone `alCambiar`, que recibe la posicion ya montada y pinta lo
   suyo, y `sugerida`, que dice cual es la continuacion "por defecto" cuando la
   linea se acaba y alguien pulsa la flecha de avanzar.
   =========================================================================== */

import { $, escapar } from './comun.js';
import { crearTablero } from './tablero.js';
import { nombrarPosicion } from './aperturas.js';

/**
 * @param pre       prefijo de los ids del HTML: 'lb' o 'ex'
 * @param alCambiar (ch, linea, i) -> void, tras cada cambio de posicion
 * @param sugerida  (ch) -> SAN | null, la continuacion por defecto
 */
export function crearNavegador({ Chess, pre, alCambiar, sugerida = () => null }) {
  const id = (s) => `#${pre}-${s}`;
  let linea = [];
  let i = 0;
  const tablero = crearTablero($(id('tablero')), { Chess, alJugar: (h) => jugar(h.san) });

  /* --- Enganches, una sola vez ------------------------------------------- */
  $(id('girar')).addEventListener('click', () => tablero.setGirado(!tablero.estaGirado()));
  $(id('inicio')).addEventListener('click', () => irA(0));
  $(id('atras')).addEventListener('click', () => irA(i - 1));
  $(id('adelante')).addEventListener('click', adelante);
  $(id('fin')).addEventListener('click', hastaElFinal);
  $(id('linea')).addEventListener('click', (e) => {
    const b = e.target.closest('.jug');
    if (b) irA(+b.dataset.k);
  });

  /* --- Estado ------------------------------------------------------------- */
  /** La posicion que corresponde a las `i` primeras jugadas de `linea`. */
  function situar() {
    const ch = new Chess();
    for (let k = 0; k < i; k++) {
      // Una linea imposible se recorta en vez de reventar: puede llegar de una
      // partida importada o de un libro construido con otra base.
      try { ch.move(linea[k]); } catch { linea = linea.slice(0, k); i = k; break; }
    }
    return ch;
  }

  function irA(k) {
    i = Math.max(0, Math.min(k, linea.length));
    pintar();
  }

  function jugar(san) {
    // Jugar algo distinto de lo que ya habia escrito a partir de aqui TRUNCA la
    // linea: si no, quedaria una continuacion que no sigue a la posicion que se
    // ve, y la lista de jugadas mentiria.
    if (linea[i] !== san) { linea = linea.slice(0, i); linea.push(san); avisarCorte(); }
    i++;
    pintar();
  }

  let alCortar = null;
  const avisarCorte = () => alCortar?.();

  function adelante() {
    if (linea[i]) return irA(i + 1);
    const san = sugerida(situar());
    if (san) jugar(san);
  }

  function hastaElFinal() {
    // Tope defensivo: sin el, una sugerencia que se enlazase consigo misma por
    // una repeticion dejaria el bucle corriendo para siempre.
    for (let n = 0; n < 60; n++) {
      if (linea[i]) { i++; continue; }
      const san = sugerida(situar());
      if (!san) break;
      linea = linea.slice(0, i);
      linea.push(san);
      i++;
    }
    pintar();
  }

  /* --- Pintado ------------------------------------------------------------ */
  function pintar() {
    const ch = situar();
    tablero.mostrar(ch.fen(), i ? ch.history({ verbose: true }).at(-1) : null);
    pintarLinea();
    pintarApertura(ch.fen());

    refrescarFlechas(ch);
    alCambiar(ch, linea, i);
  }

  /* Separado de pintar() porque el explorador de maestros no sabe si hay
     continuacion hasta que Lichess contesta: cuando llega la respuesta refresca
     solo los botones, en vez de repintar la posicion entera y arriesgarse a un
     bucle de pintar -> pedir -> pintar. */
  function refrescarFlechas(ch = situar()) {
    $(id('atras')).disabled = i === 0;
    $(id('inicio')).disabled = i === 0;
    const hayMas = !!linea[i] || !!sugerida(ch);
    $(id('adelante')).disabled = !hayMas;
    $(id('fin')).disabled = !hayMas;
  }

  function pintarLinea() {
    const caja = $(id('linea'));
    if (!linea.length) {
      caja.innerHTML = '<span class="jug-vacio">Posición inicial</span>';
      return;
    }
    // `k` es cuantas jugadas hay puestas, no el indice del array: asi el boton
    // lleva directamente el numero que espera irA() y no hay que sumar uno en
    // ningun sitio, que es de donde salen los errores de un ply.
    let html = '';
    for (let k = 1; k <= linea.length; k++) {
      if (k % 2 === 1) html += `<span class="jug-num">${(k + 1) / 2}.</span>`;
      const clases = ['jug', k === i ? 'actual' : '', k > i ? 'futura' : ''].filter(Boolean);
      html += `<button class="${clases.join(' ')}" data-k="${k}">${escapar(linea[k - 1])}</button>`;
    }
    caja.innerHTML = html;
    caja.querySelector('.jug.actual')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  /* La tabla de aperturas se carga sola y dos navegaciones rapidas pueden
     resolverse en desorden: el testigo descarta las respuestas viejas. */
  let testigo = 0;
  async function pintarApertura(fen) {
    const mio = ++testigo;
    const ap = await nombrarPosicion(fen).catch(() => null);
    if (mio !== testigo) return;
    const caja = $(id('apertura'));
    caja.classList.toggle('oculto', !ap);
    if (ap) caja.innerHTML = `<span class="apertura-eco">${escapar(ap.eco)}</span> ${escapar(ap.nombre)}`;
  }

  return {
    tablero,
    pintar,
    refrescarFlechas: () => refrescarFlechas(),
    irA,
    jugar,
    linea: () => linea,
    indice: () => i,
    fen: () => situar().fen(),
    /** Arranca una vista nueva: linea de salida, orientacion y repintado. */
    abrir({ desde = [], girado = false } = {}) {
      linea = [...desde];
      i = linea.length;
      tablero.setGirado(girado);
      pintar();
    },
    /** Cambia la linea entera manteniendo donde estabas (abrir una partida). */
    seguir(sanes) {
      const hasta = i;
      linea = [...sanes];
      i = Math.min(hasta, linea.length);
      pintar();
    },
    /** Corta lo que quede por delante (soltar la partida que se seguia). */
    soltar() {
      linea = linea.slice(0, i);
      pintar();
    },
    /** Aviso de que el usuario se ha salido de la linea escrita. */
    alSalirseDeLaLinea(f) { alCortar = f; },
  };
}
