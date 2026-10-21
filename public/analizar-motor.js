/* ===========================================================================
   OpeningChessAI — pasar tus partidas por el motor (Fase 27, B).

   Por partida: se reproducen las jugadas, se evalúa cada posición y se juzgan
   TUS jugadas (juicio.js). Las evaluaciones se guardan en el móvil por
   partida y profundidad: analizar otra vez es instantáneo, y añadir partidas
   nuevas solo cuesta las nuevas.

   Si la partida viene de Lichess con análisis hecho allí, se usa ese y no se
   gasta batería. Lichess solo da la mejor jugada donde hay error, que es
   justo donde hace falta.
   =========================================================================== */

import { Chess } from './vendor/chess.js';
import { evaluar, nuevaPartida } from './motor.js';
import { juzgar } from './juicio.js';
import { leerVario, guardarVario } from './almacen.js';

/* Cien jugadas de cada: más allá casi nunca decide nada y una partida de 150
   jugadas costaría un minuto entero de móvil. */
const PLY_MAX = 200;

const clave = (p, prof) => `motor:${prof}:${p.id}:${p.sanes.length}`;

export async function leerGuardado(p, prof) {
  const g = await leerVario(clave(p, prof));
  return g?.juicio || null;
}

/** Posiciones y jugadas en UCI/SAN de una partida. */
function reproducir(p) {
  const ch = new Chess();
  const fens = [ch.fen()];
  for (const san of p.sanes.slice(0, PLY_MAX)) {
    try { if (!ch.move(san)) break; } catch { break; }
    fens.push(ch.fen());
  }
  return fens;
}

function uciASan(fen, uci) {
  if (!uci) return null;
  const ch = new Chess(fen);
  try {
    const m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    return m?.san || null;
  } catch { return null; }
}

/** Estado terminal: no hace falta motor. */
function terminal(fen) {
  const ch = new Chess(fen);
  if (ch.isCheckmate()) return { mate: fen.split(' ')[1] === 'w' ? -1 : 1, fin: true };
  if (ch.isStalemate() || ch.isInsufficientMaterial()) return { cp: 0, fin: true };
  return null;
}

/**
 * @param p          partida con `sanes`, `ladoRival` y quizá `analisis` de Lichess
 * @param prof       profundidad
 * @param seguir     () => bool; si devuelve false se abandona a medias
 */
export async function analizarPartida(p, prof, seguir = () => true) {
  const ya = await leerGuardado(p, prof);
  if (ya) return ya;

  const fens = reproducir(p);
  if (fens.length < 7) return null;
  const n = fens.length - 1;

  let evals, mejores;
  const li = p.analisis;
  const deLichess = Array.isArray(li) && li.length >= n - 1;
  if (deLichess) {
    // Lichess: analisis[i] es la evaluacion DESPUES de la jugada i.
    evals = [{ cp: 20 }, ...li.slice(0, n).map(x => (x && (x.eval !== undefined ? { cp: x.eval }
      : x.mate !== undefined ? { mate: x.mate } : null)))];
    while (evals.length < fens.length) evals.push(terminal(fens[evals.length]) || null);
    mejores = new Array(fens.length).fill(null);
    li.forEach((x, i) => { if (x?.best) mejores[i] = uciASan(fens[i], x.best); });
  } else {
    evals = new Array(fens.length).fill(null);
    mejores = new Array(fens.length).fill(null);
    nuevaPartida();
    for (let i = 0; i < fens.length; i++) {
      if (!seguir()) return null;
      const t = terminal(fens[i]);
      if (t) { evals[i] = t; continue; }
      const r = await evaluar(fens[i], prof);
      evals[i] = r;
      mejores[i] = uciASan(fens[i], r.mejor);
    }
  }

  const juicio = juzgar(p, fens, evals, mejores);
  juicio.fuente = deLichess ? 'lichess' : 'movil';
  await guardarVario(clave(p, prof), { juicio });
  return juicio;
}
