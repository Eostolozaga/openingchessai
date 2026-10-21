/* ===========================================================================
   OpeningChessAI — juzgar jugadas a partir de evaluaciones (Fase 27, B).

   Funciones puras, sin motor ni pantalla, para poder probarlas solas.

   TODO SE MIDE EN PROBABILIDAD DE GANAR, NO EN CENTIPEONES. Perder 150
   centipeones con +8 no cambia nada; perderlos con +0,5 cambia la partida.
   Es el criterio de Lichess, y usar el mismo hace que los números se parezcan
   a los que el usuario ya conoce:

     ganar(cp)   = 2 / (1 + e^(-0.00368208·cp)) − 1        (−1 … +1)
     caída       = ganar(antes) − ganar(después), desde quien mueve
     imprecisión ≥ 0,10 · error ≥ 0,20 · error grave ≥ 0,30

   PRECISIÓN (la de Lichess):
     % = 103,1668·e^(−0,04354·(pBefore − pAfter)) − 3,1669, con p en 0…100
   La de la partida es la media entre la aritmética y la armónica de sus
   jugadas: la armónica castiga que haya UNA jugada desastrosa, que es lo que
   de verdad decide partidas entre aficionados.
   =========================================================================== */

export const UMBRAL = { imprecision: 0.10, error: 0.20, grave: 0.30 };
const TOPE_CP = 1000;

/** Evaluación {cp} o {mate} (desde BLANCAS) a centipeones acotados. */
export function aCp(e) {
  if (!e) return null;
  if (typeof e.mate === 'number') return e.mate > 0 ? TOPE_CP : e.mate < 0 ? -TOPE_CP : 0;
  if (typeof e.cp === 'number') return Math.max(-TOPE_CP, Math.min(TOPE_CP, e.cp));
  return null;
}

export const ganar = (cp) => 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;

export function precisionJugada(wcAntes, wcDespues) {
  const a = 50 + 50 * wcAntes, d = 50 + 50 * wcDespues;
  if (d >= a) return 100;
  const x = 103.1668100711649 * Math.exp(-0.04354415386753951 * (a - d)) - 3.166924740191411;
  return Math.max(0, Math.min(100, x));
}

export function precisionPartida(lista) {
  if (!lista.length) return null;
  const media = lista.reduce((s, x) => s + x, 0) / lista.length;
  const armonica = lista.length / lista.reduce((s, x) => s + 1 / Math.max(x, 1), 0);
  return (media + armonica) / 2;
}

export function clase(caida) {
  if (caida >= UMBRAL.grave) return 'grave';
  if (caida >= UMBRAL.error) return 'error';
  if (caida >= UMBRAL.imprecision) return 'imprecision';
  return null;
}

const VALOR = { q: 9, r: 5, b: 3, n: 3 };
/**
 * Fase de una posición a partir del FEN.
 * Final: queda poco material de piezas (≤ 20 entre los dos: p. ej. dos torres
 * y dos menores). Apertura: las diez primeras jugadas que no sean ya final.
 * Todo lo demás, medio juego. Es tosco a propósito: una regla que el usuario
 * entiende vale más que una exacta que no.
 */
export function faseDe(fen, ply) {
  let m = 0;
  for (const c of fen.split(' ')[0]) m += VALOR[c.toLowerCase()] || 0;
  if (m <= 20) return 'final';
  if (ply < 20) return 'apertura';
  return 'medio';
}

/**
 * Juzga las jugadas del dueño de una partida.
 *
 * @param p        la partida (`sanes`, `ladoRival`)
 * @param fens     FEN de cada posición, fens[i] = antes de la jugada i
 * @param evals    evaluación desde blancas de cada posición (mismo índice),
 *                 incluida la final (fens.length === sanes.length + 1)
 * @param mejores  mejor jugada en SAN de cada posición (puede faltar)
 */
export function juzgar(p, fens, evals, mejores) {
  const blancas = p.ladoRival === 'white';
  const precs = [];
  const errores = [];
  const fases = { apertura: [], medio: [], final: [] };
  const cuenta = { imprecision: 0, error: 0, grave: 0 };

  for (let i = 0; i < fens.length - 1; i++) {
    if ((i % 2 === 0) !== blancas) continue;
    const a = aCp(evals[i]), d = aCp(evals[i + 1]);
    if (a === null || d === null) continue;
    const signo = blancas ? 1 : -1;
    const wa = ganar(signo * a), wd = ganar(signo * d);
    const jugada = p.sanes[i];
    const mejor = mejores?.[i] || null;
    // Si jugaste la del motor no hay error, diga lo que diga la evaluacion de
    // la posicion siguiente (a poca profundidad oscila).
    const caida = mejor && mejor === jugada ? 0 : Math.max(0, wa - wd);
    const pr = caida === 0 ? 100 : precisionJugada(wa, wd);
    precs.push(pr);
    const f = faseDe(fens[i], i);
    fases[f].push(pr);
    const c = clase(caida);
    if (c) {
      cuenta[c]++;
      if (c !== 'imprecision' && mejor) {
        errores.push({ ply: i, fen: fens[i], san: jugada, mejor, caida: +caida.toFixed(3),
                       clase: c, fase: f, antes: signo * a, despues: signo * d });
      }
    }
  }

  const media = (l) => (l.length ? l.reduce((s, x) => s + x, 0) / l.length : null);
  return {
    precision: precisionPartida(precs),
    jugadas: precs.length,
    fases: { apertura: media(fases.apertura), medio: media(fases.medio), final: media(fases.final) },
    nFases: { apertura: fases.apertura.length, medio: fases.medio.length, final: fases.final.length },
    cuenta,
    errores,
  };
}
