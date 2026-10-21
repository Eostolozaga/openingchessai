/* ===========================================================================
   OpeningChessAI — nombres de apertura.

   Una tabla EPD -> "ECO|Nombre" con 3.810 posiciones, derivada del conjunto de
   datos de aperturas de Lichess (dominio publico). 60 KB comprimidos.

   Sirve para no tener que ensenar nunca un codigo ECO a secas. "B12" no le
   dice nada a nadie; "Caro-Kann, Variante del Avance" si, y es el mismo dato.

   Se carga bajo demanda y una sola vez: la pantalla de Cursos no la necesita,
   pero Repertorio y el visor si. El navegador la cachea y el service worker la
   guarda en cuanto se pide por primera vez.
   =========================================================================== */

let tabla = null;
let cargando = null;

async function cargar() {
  if (tabla) return tabla;
  if (!cargando) {
    cargando = fetch('/datos/aperturas.json')
      .then(r => r.json())
      .then(d => { tabla = d; return d; })
      // Sin la tabla la app funciona igual, solo que sin nombres bonitos.
      // No merece romper una pantalla entera por eso.
      .catch(() => { tabla = {}; return tabla; });
  }
  return cargando;
}

/** EPD = FEN sin los contadores de jugada. Es lo que identifica una posicion
 *  a efectos de apertura: el numero de jugada no cambia de que apertura es. */
export const epdDe = (fen) => fen.split(' ').slice(0, 4).join(' ');

/**
 * Nombre de la apertura de una secuencia de jugadas.
 *
 * Se recorre la linea entera y se guarda la ULTIMA coincidencia, no la
 * primera: toda partida pasa por posiciones con nombre generico antes de
 * llegar a la concreta, y lo util es la mas concreta. `1.e4 c6 2.d4 d5 3.e5`
 * es la Caro-Kann del Avance, no "Caro-Kann" a secas ni "Apertura de peon de
 * rey", que tambien coinciden por el camino.
 */
export async function nombrarLinea(Chess, sanes) {
  const t = await cargar();
  const ch = new Chess();
  let ultimo = null;
  for (const san of sanes) {
    try { ch.move(san); } catch { break; }
    const v = t[epdDe(ch.fen())];
    if (v) ultimo = v;
  }
  return partir(ultimo);
}

/** La tabla entera, ya cargada. La necesita quien tenga que consultarla miles
 *  de veces seguidas y no pueda permitirse un await por consulta: recorrer un
 *  arbol de repertorio entero, por ejemplo. */
export async function tablaAperturas() { return cargar(); }

/** Nombre de una posicion concreta, si esa posicion exacta tiene nombre. */
export async function nombrarPosicion(fen) {
  const t = await cargar();
  return partir(t[epdDe(fen)]);
}

function partir(v) {
  if (!v) return null;
  const i = v.indexOf('|');
  return { eco: v.slice(0, i), nombre: v.slice(i + 1) };
}
