/* ===========================================================================
   OpeningChessAI — Stockfish en el móvil (Fase 27, B).

   Stockfish 19 «lite» de un solo hilo, compilado a WebAssembly
   (vendor/stockfish, GPLv3, de nmrugg/stockfish.js). 1,8 MB. Se eligió ese y
   no el grande (94 MB) ni el multihilo (exige cabeceras COOP/COEP en todo el
   sitio): a profundidad 12 sigue muy por encima de cualquier humano y en un
   móvil normal va a unas décimas de segundo por posición.

   NO PASA POR EL WORKER DE CLOUDFLARE. Analizar en el edge con 10 ms de CPU
   no es posible, y aquí cada usuario pone su propio procesador.

   Un solo motor para toda la app y una cola: pedirle dos posiciones a la vez
   mezclaría las respuestas.
   =========================================================================== */

const RUTA = '/vendor/stockfish/stockfish-19-lite-single.js';

let w = null;
let listo = null;
let oyente = null;
let cola = Promise.resolve();

function arrancar() {
  if (listo) return listo;
  listo = new Promise((res, rej) => {
    try { w = new Worker(RUTA); } catch (e) { rej(e); return; }
    w.onerror = (e) => { rej(new Error(e.message || 'no arranca el motor')); listo = null; };
    w.onmessage = (e) => {
      const l = String(e.data);
      if (l === 'readyok' && !oyente) { res(); return; }
      oyente?.(l);
    };
    w.postMessage('uci');
    w.postMessage('setoption name Hash value 16');
    w.postMessage('isready');
  });
  return listo;
}

/**
 * Evalúa una posición. Devuelve la evaluación DESDE BLANCAS y la mejor
 * jugada en UCI: { cp } o { mate }, y { mejor }.
 */
export function evaluar(fen, profundidad = 12) {
  const tarea = cola.then(async () => {
    await arrancar();
    return new Promise((res) => {
      const blancas = fen.split(' ')[1] === 'w';
      let ultima = null;
      oyente = (l) => {
        if (l.startsWith('info') && l.includes(' score ') && !l.includes(' lowerbound') && !l.includes(' upperbound')) {
          const m = / score (cp|mate) (-?\d+)/.exec(l);
          if (m) ultima = { tipo: m[1], v: +m[2] };
        } else if (l.startsWith('bestmove')) {
          oyente = null;
          const mejor = l.split(' ')[1];
          const s = blancas ? 1 : -1;
          const e = !ultima ? {}
            : ultima.tipo === 'mate' ? { mate: s * ultima.v } : { cp: s * ultima.v };
          res({ ...e, mejor: mejor && mejor !== '(none)' ? mejor : null });
        }
      };
      w.postMessage('position fen ' + fen);
      w.postMessage('go depth ' + profundidad);
    });
  });
  cola = tarea.catch(() => {});
  return tarea;
}

export function nuevaPartida() {
  if (w) w.postMessage('ucinewgame');
}

/** Corta lo que esté pensando. La tarea en curso responde con su bestmove. */
export function parar() {
  if (w) w.postMessage('stop');
}
