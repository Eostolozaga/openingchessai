/* ===========================================================================
   OpeningChessAI — de donde salen las partidas.

   Vivian dentro de rival.js. Desde la Fase 27 las usan DOS pestañas —Rival,
   que mira las de otro, y Análisis, que mira las tuyas— y la regla de la casa
   es la de bloques.js: una copia por pantalla garantiza que un dia se arregle
   en una y se quede roto en la otra.

   Todas devuelven la misma forma de partida:

     { id, ladoRival, sanes, eco, apertura, contrario, eloContrario,
       puntos, fecha, torneo }

   `torneo` lo traen el volcado FIDE (Fase 31), el PGN subido a mano (su
   Event) y los torneos de Chess.com; las de Lichess lo llevan a null.

   `ladoRival` es el color del DUEÑO de la lista —el rival en Rival, tú en
   Análisis— y `puntos` se cuenta desde su punto de vista. El nombre se queda
   por historia: cambiarlo tocaria media docena de modulos sin ganar nada.
   =========================================================================== */

import { leerVario, guardarVario } from './almacen.js';

const LICHESS = 'https://lichess.org';

export async function fichaLichess(usuario) {
  const r = await fetch(`${LICHESS}/api/user/${encodeURIComponent(usuario)}`);
  if (r.status === 404) throw new Error(`No existe el usuario «${usuario}» en Lichess.`);
  if (r.status === 429) throw new Error('Lichess ha pedido esperar un momento. Prueba en un minuto.');
  if (!r.ok) throw new Error(`Lichess respondió ${r.status}.`);
  const u = await r.json();
  if (u.disabled) throw new Error('Esa cuenta está cerrada.');
  return u;
}

/**
 * Descarga en NDJSON y va entregando el recuento.
 *
 * `moves=true&opening=true` en vez de traerse el PGN entero: la lista de
 * jugadas en SAN es lo unico que hace falta y el PGN pesa el triple por las
 * cabeceras y los relojes.
 */
export async function bajarPartidasLichess(usuario, { max = 300, perf = '', evals = false,
                                                      since = 0, until = 0, alAvanzar = () => {} } = {}) {
  const q = new URLSearchParams({
    max: String(max), moves: 'true', opening: 'true',
    rated: 'true', sort: 'dateDesc', clocks: 'false', evals: String(evals),
  });
  if (perf) q.set('perfType', perf);
  if (since) q.set('since', String(since));
  if (until) q.set('until', String(until));

  const r = await fetch(`${LICHESS}/api/games/user/${encodeURIComponent(usuario)}?${q}`,
                        { headers: { accept: 'application/x-ndjson' } });
  if (r.status === 429) throw new Error('Lichess ha pedido esperar. Prueba en un minuto.');
  if (!r.ok) throw new Error(`Lichess respondió ${r.status} al pedir las partidas.`);

  const lector = r.body.getReader();
  const dec = new TextDecoder();
  const fuera = [];
  let resto = '';

  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    resto += dec.decode(value, { stream: true });
    const lineas = resto.split('\n');
    resto = lineas.pop();
    for (const l of lineas) {
      if (!l.trim()) continue;
      const g = compactar(JSON.parse(l), usuario);
      if (g) fuera.push(g);
    }
    alAvanzar(fuera.length, fuera);
  }
  if (resto.trim()) {
    const g = compactar(JSON.parse(resto), usuario);
    if (g) fuera.push(g);
  }
  return fuera;
}

/**
 * Las de Rival: las que ya estan en el movil mas SOLO las nuevas (Fase 34).
 *
 * Se guardan por usuario y cadencia, y la siguiente vez se pide a Lichess
 * solo lo posterior a la mas reciente (`since`). Dos casos especiales:
 *
 *   · Si lo nuevo llena el tope entero, puede haber un hueco entre lo nuevo y
 *     lo guardado: se tira lo guardado y se empieza de cero con lo nuevo.
 *   · Si se pide un tope mayor que lo guardado y no se sabe si hay mas, se
 *     piden las anteriores a la mas vieja (`until`). Cuando Lichess devuelve
 *     menos de las pedidas, es que no hay mas: se apunta y no se vuelve a
 *     preguntar.
 *
 * `alAvanzar(n, lista)` recibe la lista de lo que va llegando, para que Rival
 * pueda ir analizando antes de que termine.
 */
const GUARDA_LICHESS = 2000;

export async function partidasLichessRival(usuario, { max = 300, perf = '', alAvanzar = () => {} } = {}) {
  const u = usuario.toLowerCase();
  const clave = `li:${u}:${perf || 'todas'}`;
  const g = await leerVario(clave);
  let guardadas = g?.partidas || [];
  let completo = !!g?.completo;

  const ultima = guardadas.reduce((m, p) => Math.max(m, p.fecha || 0), 0);
  const nuevas = await bajarPartidasLichess(usuario, {
    max, perf, since: ultima ? ultima + 1 : 0,
    alAvanzar: (n, lista) => alAvanzar(n + (ultima ? guardadas.length : 0), lista),
  });
  if (!g) completo = nuevas.length < max;
  if (nuevas.length >= max) { guardadas = []; completo = false; }

  const ya = new Set(nuevas.map(p => p.id));
  const lista = [...nuevas, ...guardadas.filter(p => !ya.has(p.id))];

  if (lista.length < max && !completo && lista.length) {
    const vieja = lista.reduce((m, p) => Math.min(m, p.fecha || Infinity), Infinity);
    const faltan = max - lista.length;
    const antes = await bajarPartidasLichess(usuario, { max: faltan, perf, until: vieja - 1 });
    if (antes.length < faltan) completo = true;
    const ya2 = new Set(lista.map(p => p.id));
    for (const p of antes) if (!ya2.has(p.id)) lista.push(p);
  }

  lista.sort((a, b) => (b.fecha || 0) - (a.fecha || 0));
  const recortada = lista.length > GUARDA_LICHESS;
  await guardarVario(clave, { ts: Date.now(), partidas: lista.slice(0, GUARDA_LICHESS),
                              completo: completo && !recortada });
  return { partidas: lista.slice(0, max), nuevas: nuevas.length };
}

/** Deja de cada partida solo lo que el analisis necesita. */
function compactar(g, usuario) {
  if (g.variant && g.variant !== 'standard') return null;
  if (!g.moves) return null;

  const u = usuario.toLowerCase();
  const lado = g.players?.white?.user?.id === u ? 'white'
             : g.players?.black?.user?.id === u ? 'black' : null;
  if (!lado) return null;

  const otro = lado === 'white' ? g.players?.black : g.players?.white;

  return {
    id: g.id,
    ladoRival: lado,
    sanes: g.moves.split(' '),
    eco: g.opening?.eco || null,
    apertura: g.opening?.name || null,
    // Con quien la jugo. No entra en el cruce de huecos, pero sin esto la lista
    // de partidas del libro es una columna de fechas sin nada a lo que agarrarse.
    contrario: otro?.user?.name || otro?.user?.id || (otro?.aiLevel ? `Ordenador nivel ${otro.aiLevel}` : null),
    eloContrario: otro?.rating || null,
    // Puntuacion desde el punto de vista del rival: es su rendimiento lo que
    // se esta midiendo, no el de quien tuviera blancas.
    puntos: !g.winner ? 0.5 : g.winner === lado ? 1 : 0,
    fecha: g.createdAt,
    // El analisis que Lichess ya hizo, si lo hay (solo con `evals`). Analisis
    // lo usa para no gastar motor; Rival nunca lo pide.
    analisis: g.analysis || undefined,
  };
}

/** Fila del volcado -> la misma forma que traen las partidas de Lichess. */
export function convertirFide(x, id) {
  // El volcado guarda siete campos desde el principio; hasta ahora aqui solo se
  // leian cinco y el nombre del contrario se tiraba a la basura sin querer.
  // El octavo, el torneo, llega con la Fase 31; los cubos de antes no lo
  // traen y salen con `torneo: null`, sin romper nada.
  const [lado, eco, jugadas, res, fecha, contrario, elo, torneo] = x;
  const gano = res === '1-0' ? 'w' : res === '0-1' ? 'b' : null;
  return {
    id, ladoRival: lado === 'w' ? 'white' : 'black',
    sanes: jugadas.split(' '),
    eco, apertura: null,
    contrario: contrario || null,
    eloContrario: elo || null,
    puntos: gano === null ? 0.5 : gano === lado ? 1 : 0,
    fecha,
    torneo: torneo || null,
  };
}

/* ===========================================================================
   Las tuyas en la base FIDE
   ===========================================================================
   El mismo cubo que usa Rival —`fide_id % cubos`— pero sin buscador: la ficha
   ya es la tuya, declarada o confirmada por Lichess. */
let metaFide = null;

export async function partidasFide(api, fid) {
  if (!metaFide) metaFide = await api('art/rivales/meta.json.gz');
  const cubo = await api(`art/rivales/jugadores/${Number(fid) % (metaFide?.cubos || 2048)}.json.gz`);
  const j = cubo[fid];
  if (!j?.g?.length) return { perfil: null, partidas: [] };
  return {
    perfil: { nombre: j.n || String(fid), titulo: j.t,
              sub: [j.fed, j.e && `${j.e} Elo`].filter(Boolean).join(' · ') },
    partidas: j.g.map((x, i) => convertirFide(x, fid + '-' + i)),
  };
}

/* ===========================================================================
   PGN subido a mano
   ===========================================================================
   Un PGN exportado de cualquier programa o plataforma de ajedrez. Solo interesa la LINEA PRINCIPAL: las variantes entre parentesis son
   analisis de alguien, no lo que se jugo, y meterlas contaria jugadas que nunca
   estuvieron en el tablero.

   El corte entre partidas se hace por linea, como en chesscom.js: una cabecera
   que aparece DESPUES de jugadas abre partida nueva. Buscar «[Event» no basta:
   hay exportadores que no la escriben.
   =========================================================================== */

export function trocearPgn(texto) {
  const partidas = [];
  let cab = {}, cuerpo = [], enJugadas = false;

  const cerrar = () => {
    if (Object.keys(cab).length || cuerpo.length) partidas.push({ cab, cuerpo: cuerpo.join(' ') });
    cab = {}; cuerpo = []; enJugadas = false;
  };

  for (const l of String(texto).replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/.exec(l);
    if (m) {
      if (enJugadas) cerrar();
      cab[m[1]] = m[2].replace(/\\(.)/g, '$1');
      continue;
    }
    if (l.trim()) { enJugadas = true; cuerpo.push(l); }
  }
  cerrar();
  return partidas;
}

/** Linea principal en SAN, sin comentarios, variantes, NAG ni numeros. */
export function lineaPrincipal(cuerpo) {
  let s = String(cuerpo)
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\n]*/g, ' ');
  // Variantes anidadas: se quitan de dentro hacia fuera hasta que no quede
  // ninguna. Una expresion sola no puede con el anidamiento.
  let antes;
  do { antes = s; s = s.replace(/\([^()]*\)/g, ' '); } while (s !== antes);
  return s
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/(1-0|0-1|1\/2-1\/2|\*)\s*$/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/[!?]+$/, ''))
    .filter(t => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}

/** Sin acentos, minusculas y solo letras: «García, José» == «garcia jose». */
export const plano = (s) => String(s || '').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Quien eres tu dentro del PGN.
 *
 * Con nombre escrito: la partida es tuya si TODAS sus palabras estan en el
 * nombre de un lado. Asi «apellido» casa con «Apellido Apellido, Nombre» y no
 * hace falta acertar con el orden ni con las comas.
 *
 * Sin nombre: el que mas veces aparece. Un PGN de tus partidas tiene tu nombre
 * en todas; cualquier otro, como mucho en unas pocas.
 */
export function detectarJugador(trozos) {
  const cuenta = new Map();
  for (const t of trozos) {
    for (const k of ['White', 'Black']) {
      const n = (t.cab[k] || '').trim();
      if (!n || n === '?') continue;
      const c = plano(n);
      const x = cuenta.get(c) || { n: 0, original: n };
      x.n++;
      cuenta.set(c, x);
    }
  }
  const [mejor] = [...cuenta.values()].sort((a, b) => b.n - a.n);
  return mejor ? mejor.original : '';
}

export function partidasDePgn(texto, nombre) {
  const trozos = trocearPgn(texto);
  const quien = (nombre || '').trim() || detectarJugador(trozos);
  const palabras = plano(quien).split(' ').filter(Boolean);
  const casa = (n) => {
    if (!palabras.length) return false;
    const suyas = new Set(plano(n).split(' '));
    return palabras.every(p => suyas.has(p));
  };

  const partidas = [];
  let ajenas = 0, raras = 0;

  trozos.forEach((t, i) => {
    const h = t.cab;
    if (h.SetUp === '1' || (h.FEN && !h.FEN.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w'))) {
      raras++; return;
    }
    if (h.Variant && !/^standard$/i.test(h.Variant)) { raras++; return; }
    const b = casa(h.White), n = casa(h.Black);
    // Las dos a la vez es un nombre demasiado corto («jose»): no se puede
    // saber cual eres, y adivinar pondria la mitad de partidas del reves.
    if (b === n) { ajenas++; return; }
    const lado = b ? 'white' : 'black';
    const sanes = lineaPrincipal(t.cuerpo);
    if (sanes.length < 6) { raras++; return; }

    const res = h.Result || '*';
    const puntos = res === '1/2-1/2' ? 0.5
      : res === '1-0' ? (lado === 'white' ? 1 : 0)
      : res === '0-1' ? (lado === 'black' ? 1 : 0)
      : null;
    if (puntos === null) { raras++; return; }

    const fecha = (h.Date || h.UTCDate || '').replace(/\./g, '-').replace(/-\?\?.*$/, '');
    const otro = lado === 'white' ? h.Black : h.White;
    const eloOtro = lado === 'white' ? h.BlackElo : h.WhiteElo;

    partidas.push({
      id: 'pgn-' + i,
      ladoRival: lado,
      sanes,
      eco: h.ECO || null,
      apertura: h.Opening ? [h.Opening, h.Variation].filter(Boolean).join(': ') : null,
      contrario: otro && otro !== '?' ? otro : null,
      eloContrario: /^\d+$/.test(eloOtro || '') ? +eloOtro : null,
      puntos,
      fecha: /^\d{4}/.test(fecha) ? fecha.slice(0, 10) : null,
      torneo: h.Event && h.Event !== '?' ? h.Event.trim() : null,
    });
  });

  return { partidas, quien, total: trozos.length, ajenas, raras };
}
