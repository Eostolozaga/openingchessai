/* ===========================================================================
   OpeningChessAI — la voz (Fase 37).

   Dos direcciones y un traductor en medio:

     · HABLAR. `speechSynthesis` del propio movil: gratis, sin red, y con voz
       en castellano en cualquier Android o iPhone. Las jugadas se dicen como
       se dicen en un club —«caballo efe seis», «e toma en de cinco»,
       «enroque corto»— y no letra a letra, que es lo que haria la voz con
       «Nf6» a pelo.

     · ESCUCHAR. Primero el reconocimiento del navegador (Chrome, Safari):
       instantaneo y gratis. Si no existe o el sistema lo niega —Firefox, o
       un iPhone con la app instalada en la pantalla de inicio, donde Safari
       a veces lo apaga—, se graba la frase y la transcribe Whisper en
       Workers AI (`/api/voz`). La grabacion se corta sola al callarse uno
       (detector de silencio con umbral que se adapta al ruido de la calle) y
       NO se manda nada si no se ha detectado voz: el silencio no gasta cupo.

     · TRADUCIR. De lo que se ha dicho a una jugada LEGAL de la posicion. No se
       intenta reconstruir el SAN exacto: se sacan pieza, casilla de destino y
       lo que haya de origen, y se filtra entre las jugadas legales. Es mucho
       mas tolerante con lo que devuelve un reconocedor —«caballo F3»,
       «caballo efe tres», «C f 3»— y no puede devolver nunca una jugada
       imposible.

   El audio que se graba para Whisper va en WAV de 16 kHz hecho aqui y no con
   MediaRecorder: cada navegador graba en un formato (webm, mp4, ogg) y el
   WAV lo entiende cualquier transcriptor sin sorpresas.
   =========================================================================== */

import { api } from './comun.js';

/* ===========================================================================
   HABLAR
   =========================================================================== */
const sintesis = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
let vozEs = null;

function elegirVoz() {
  if (!sintesis) return null;
  const voces = sintesis.getVoices();
  // Castellano de España si hay; si no, cualquier castellano. Las «Google»
  // y las «Enhanced» suenan bastante mejor que las de serie.
  const es = voces.filter(v => /^es[-_]/i.test(v.lang) || v.lang === 'es');
  const nota = (v) => (/es[-_]ES/i.test(v.lang) ? 4 : 0) +
                      (/google|enhanced|premium|monica|jorge/i.test(v.name) ? 2 : 0) +
                      (v.localService ? 1 : 0);
  vozEs = es.sort((a, b) => nota(b) - nota(a))[0] || null;
  return vozEs;
}
if (sintesis) {
  elegirVoz();
  sintesis.addEventListener?.('voiceschanged', elegirVoz);
}

export const puedeHablar = () => !!sintesis;

/** iOS no deja hablar si la primera locucion no sale de un toque. Se llama
 *  dentro del manejador del boton, ANTES de cualquier await. */
export function desbloquearAudio() {
  if (!sintesis) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    sintesis.speak(u);
  } catch { /* nada */ }
}

let turnoHabla = 0;

/**
 * Dice un texto y resuelve al terminar. Los textos largos se trocean por
 * frases: Chrome en Android corta en seco las locuciones de mas de ~15 s.
 * Con `encolar` no se calla lo que se estaba diciendo.
 */
export function hablar(texto, { encolar = false, velocidad = 1.05 } = {}) {
  if (!sintesis || !texto) return Promise.resolve();
  const mio = encolar ? turnoHabla : ++turnoHabla;
  if (!encolar) sintesis.cancel();
  const trozos = String(texto).split(/(?<=[.!?])\s+/).filter(Boolean);
  return trozos.reduce((p, t) => p.then(() => mio !== turnoHabla ? null : new Promise((ok) => {
    const u = new SpeechSynthesisUtterance(t);
    u.lang = vozEs?.lang || 'es-ES';
    if (vozEs) u.voice = vozEs;
    u.rate = velocidad;
    let hecho = false;
    const fin = () => { if (!hecho) { hecho = true; clearTimeout(t0); ok(); } };
    u.onend = fin; u.onerror = fin;
    // Red de seguridad: hay motores que no disparan `end` nunca. 90 ms por
    // caracter da de sobra para una frase y no deja el bucle colgado.
    const t0 = setTimeout(fin, 1500 + t.length * 90);
    sintesis.speak(u);
  })), Promise.resolve());
}

export function callar() {
  turnoHabla++;
  sintesis?.cancel();
}

/* --- Jugadas en voz alta ------------------------------------------------- */
const LETRA = { a: 'a', b: 'be', c: 'ce', d: 'de', e: 'e', f: 'efe', g: 'ge', h: 'hache' };
const NUM = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho'];
const PIEZA = { K: 'rey', Q: 'dama', R: 'torre', B: 'alfil', N: 'caballo' };
const casillaVoz = (c) => `${LETRA[c[0]]} ${NUM[+c[1]]}`;

/** «Nxe5+» → «caballo toma en e cinco, jaque». */
export function sanAVoz(san) {
  const s = String(san || '').trim();
  const jaque = /#$/.test(s) ? ', jaque mate' : /\+$/.test(s) ? ', jaque' : '';
  const b = s.replace(/[+#!?]+$/, '');
  if (/^O-O-O$|^0-0-0$/.test(b)) return 'enroque largo' + jaque;
  if (/^O-O$|^0-0$/.test(b)) return 'enroque corto' + jaque;
  const m = b.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=?([QRBN]))?$/);
  if (!m) return s;
  const [, p, cf, ff, x, dest, promo] = m;
  const partes = [];
  if (p) partes.push(PIEZA[p]);
  if (cf) partes.push(LETRA[cf]);
  if (ff) partes.push(NUM[+ff]);
  partes.push(x ? `toma en ${casillaVoz(dest)}` : casillaVoz(dest));
  if (promo) partes.push(`y corona ${PIEZA[promo]}`);
  return partes.join(' ') + jaque;
}

/* --- La posicion en palabras (Fase 38) ----------------------------------
   Para el modo sin tablero: donde esta cada pieza. En pantalla con las
   letras de la notacion española (R D T A C) y en voz con los nombres. Se
   agrupa por tipo y los peones al final, que es como se lee un diagrama. */
const LETRA_ES = { k: 'R', q: 'D', r: 'T', b: 'A', n: 'C', p: '' };
const NOMBRE_ES = { k: ['rey', 'rey'], q: ['dama', 'damas'], r: ['torre', 'torres'],
  b: ['alfil', 'alfiles'], n: ['caballo', 'caballos'], p: ['peón', 'peones'] };
const ORDEN_P = ['k', 'q', 'r', 'b', 'n', 'p'];

/** Piezas de un FEN por color y tipo: { w: { k: ['g1'], … }, b: { … } }. */
export function piezasDe(fen) {
  const out = { w: {}, b: {} };
  const filas = String(fen).split(' ')[0].split('/');
  filas.forEach((f, i) => {
    let c = 0;
    for (const x of f) {
      if (/\d/.test(x)) { c += +x; continue; }
      const color = x === x.toUpperCase() ? 'w' : 'b';
      const t = x.toLowerCase();
      (out[color][t] ||= []).push('abcdefgh'[c] + (8 - i));
      c++;
    }
  });
  for (const col of ['w', 'b']) for (const t in out[col]) out[col][t].sort();
  return out;
}

/** { texto, voz } con la posicion entera. `primero` = color que se dice antes. */
export function describirPosicion(fen, primero = 'w') {
  const p = piezasDe(fen);
  const turno = String(fen).split(' ')[1];
  const lados = primero === 'b' ? ['b', 'w'] : ['w', 'b'];
  const nombre = { w: 'Blancas', b: 'Negras' };
  const texto = lados.map(c => `${nombre[c]}: ` + ORDEN_P.filter(t => p[c][t])
    .map(t => t === 'p' ? `peones ${p[c][t].join(' ')}` : p[c][t].map(s => LETRA_ES[t] + s).join(' '))
    .join(' · ')).join('\n');
  const voz = lados.map(c => `${nombre[c]}: ` + ORDEN_P.filter(t => p[c][t]).map(t => {
    const l = p[c][t], [uno, varios] = NOMBRE_ES[t];
    const cs = l.map(casillaVoz);
    const lista = cs.length > 1 ? cs.slice(0, -1).join(', ') + ' y ' + cs.at(-1) : cs[0];
    return `${l.length > 1 ? varios : uno} en ${lista}`;
  }).join('; ') + '.').join(' ') + (turno ? ` Juegan ${turno === 'w' ? 'blancas' : 'negras'}.` : '');
  return { texto, voz };
}

/** La linea entera para decirla: «Uno: e cuatro, e seis. Dos: …». `desde`
 *  es la media jugada de la primera (si es de negras, empieza «Siete, negras:»). */
export function lineaAVoz(sanes, desde = 0) {
  const frases = [];
  for (let k = 0; k < sanes.length; k++) {
    const i = desde + k, n = Math.floor(i / 2) + 1;
    if (i % 2 === 0) {
      const negras = sanes[k + 1];
      frases.push(`${n}: ${sanAVoz(sanes[k])}${negras ? ', ' + sanAVoz(negras) : ''}.`);
      k++;
    } else {
      frases.push(`${n}, negras: ${sanAVoz(sanes[k])}.`);
    }
  }
  return frases.join(' ');
}

/** Para leer en voz alta un texto con jugadas dentro (el asistente). */
export function textoAVoz(t) {
  return String(t || '')
    .replace(/\b(\d+)\.(?:\.\.|…)?\s*/g, '$1: ')
    .replace(/\b(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?[+#]?)(?=$|[\s,.;:)%])/g, (m) => sanAVoz(m))
    .replace(/%/g, ' por ciento')
    .replace(/·/g, ',');
}

/* ===========================================================================
   TRADUCIR: lo dicho → jugada legal
   =========================================================================== */
const plano = (s) => String(s ?? '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

const W_PIEZA = {
  rey: 'k', dama: 'q', reina: 'q', torre: 'r', alfil: 'b', caballo: 'n',
  peon: 'p', king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p',
};
/* Letras de columna. Las «debiles» son tambien palabras corrientes («a»,
   «de», «e», «y», «se»): solo cuentan como columna pegadas a un numero o a
   otra casilla, no sueltas en medio de una frase. */
const W_LETRA = {
  a: 'a', b: 'b', be: 'b', ve: 'b', uve: 'b', c: 'c', ce: 'c', se: 'c',
  d: 'd', de: 'd', e: 'e', y: 'e', he: 'e', f: 'f', efe: 'f', g: 'g', ge: 'g',
  je: 'g', h: 'h', hache: 'h', ache: 'h',
};
const DEBILES = new Set(['a', 'de', 'e', 'y', 'se', 'he']);
const W_NUM = {
  1: 1, uno: 1, un: 1, una: 1, 2: 2, dos: 2, 3: 3, tres: 3, 4: 4, cuatro: 4,
  5: 5, cinco: 5, 6: 6, seis: 6, 7: 7, siete: 7, 8: 8, ocho: 8,
};
const W_TOMA = new Set(['x', 'toma', 'tomo', 'come', 'como', 'por', 'captura', 'takes', 'cambia']);
const W_CORONA = new Set(['corona', 'corono', 'promociona', 'promueve', 'promotes', '=']);

/** Trocea lo dicho en piezas, columnas, filas y marcas. */
function fichas(texto) {
  const out = [];
  // El SAN tecleado o dictado «pegado» (Nf3, exd5, Cf3) se mira con su caja
  // original: una mayuscula es pieza, una minuscula es columna.
  for (const crudo of String(texto).replace(/[,.;:!?¿¡()"]/g, ' ').split(/\s+/).filter(Boolean)) {
    const pegado = crudo.match(/^([KQRBNCATD])?([a-h])?([1-8])?(x|:)?([a-h])([1-8])(=?[QRBNDTAC])?[+#]?$/);
    if (pegado) {
      const [, p, cf, ff, x, c, f, pr] = pegado;
      const pz = { K: 'k', Q: 'q', D: 'q', R: 'r', T: 'r', B: 'b', A: 'b', N: 'n', C: 'n' };
      if (p) out.push({ t: 'p', v: pz[p] });
      if (cf) out.push({ t: 'c', v: cf, fuerte: true });
      if (ff) out.push({ t: 'f', v: +ff });
      if (x) out.push({ t: 'x' });
      out.push({ t: 'c', v: c, fuerte: true }, { t: 'f', v: +f });
      if (pr) out.push({ t: 'cor' }, { t: 'p', v: pz[pr.replace('=', '')] });
      continue;
    }
    const w = plano(crudo);
    if (/^o-?o-?o$|^0-0-0$/.test(w)) { out.push({ t: 'enr', v: 'largo' }); continue; }
    if (/^o-?o$|^0-0$/.test(w)) { out.push({ t: 'enr', v: 'corto' }); continue; }
    // «f3», «e4» en minusculas, y lo que el reconocedor junta: «d5», «84»…
    const m = w.match(/^([a-h])([1-8])$/);
    if (m) { out.push({ t: 'c', v: m[1], fuerte: true }, { t: 'f', v: +m[2] }); continue; }
    if (W_PIEZA[w] || W_PIEZA[w.replace(/s$/, '')]) { out.push({ t: 'p', v: W_PIEZA[w] || W_PIEZA[w.replace(/s$/, '')] }); continue; }
    if (w in W_NUM) { out.push({ t: 'f', v: W_NUM[w] }); continue; }
    if (W_LETRA[w]) { out.push({ t: 'c', v: W_LETRA[w], fuerte: !DEBILES.has(w) }); continue; }
    if (W_TOMA.has(w)) { out.push({ t: 'x' }); continue; }
    if (W_CORONA.has(w)) { out.push({ t: 'cor' }); continue; }
    if (/^enroc|^enroq|^castle/.test(w)) { out.push({ t: 'enr', v: '' }); continue; }
    if (w === 'corto' || w === 'short') { out.push({ t: 'lado', v: 'corto' }); continue; }
    if (w === 'largo' || w === 'long') { out.push({ t: 'lado', v: 'largo' }); continue; }
    out.push({ t: '?' });
  }
  return out;
}

/** Lo que se ha dicho, sin decidir aun la jugada: pieza, destino, origen. */
function analizar(texto) {
  const f = fichas(texto);
  const enr = f.find(x => x.t === 'enr');
  if (enr) {
    const lado = enr.v || f.find(x => x.t === 'lado')?.v || '';
    return { enroque: lado || 'cualquiera' };
  }
  const lado = f.find(x => x.t === 'lado');
  if (lado && f.length <= 2) return { enroque: lado.v };

  // Destino: la ULTIMA columna seguida de fila. «Alfil toma en de cinco» y
  // «e por d5» acaban en la casilla de llegada; lo de antes es origen.
  let k = -1;
  for (let i = f.length - 2; i >= 0; i--) {
    if (f[i].t === 'c' && f[i + 1].t === 'f') { k = i; break; }
  }
  if (k < 0) return null;
  const a = f[k].v + f[k + 1].v;

  const antes = f.slice(0, k), despues = f.slice(k + 2);
  const pieza = antes.find(x => x.t === 'p')?.v || null;
  // Origen: lo que queda entre la pieza y el destino, quitando la toma. Si
  // era un articulo («alfil A be cinco») el filtro se queda sin jugadas y
  // resolver() lo ignora: el origen solo se usa cuando deshace un empate.
  const mitad = antes.slice(antes.findIndex(x => x.t === 'p') + 1).filter(x => x.t !== 'x' && x.t !== '?');
  let deCol = null, deFila = null;
  for (const x of mitad) {
    if (x.t === 'c') deCol = x.v;
    if (x.t === 'f') deFila = x.v;
  }
  const iCor = despues.findIndex(x => x.t === 'cor');
  const promo = (iCor >= 0 ? despues.slice(iCor) : despues).find(x => x.t === 'p')?.v || null;
  return { pieza, a, deCol, deFila, promo };
}

/**
 * De lo dicho a una jugada legal de `ch` (chess.js). Acepta varias
 * alternativas del reconocedor y se queda con la primera que encaje.
 * Devuelve { jugada } (verbose de chess.js), { ambiguas: [san…] },
 * { ilegal, a } si se entendio una casilla sin jugada posible, o null.
 */
export function vozAJugada(textos, ch) {
  const legales = ch.moves({ verbose: true });
  let otra = null;
  for (const texto of [].concat(textos)) {
    const r = resolver(texto, legales);
    if (r?.jugada) return r;
    // Una alternativa ambigua vale mas que una ilegal: la ilegal suele ser
    // el reconocedor oyendo mal una letra.
    if (r?.ambiguas && !otra?.ambiguas) otra = r;
    else if (r && !otra) otra = r;
  }
  return otra;
}

function resolver(texto, legales) {
  const t = String(texto || '').trim();
  if (!t) return null;
  // Tal cual, por si es SAN limpio («Nf3», «exd5», «O-O»).
  const limpio = t.replace(/[+#!?]+$/, '');
  const exacta = legales.find(m => m.san.replace(/[+#]$/, '') === limpio);
  if (exacta) return { jugada: exacta };

  const d = analizar(t);
  if (!d) return null;
  if (d.enroque) {
    const enr = legales.filter(m => m.flags.includes('k') || m.flags.includes('q'))
      .filter(m => d.enroque === 'cualquiera' || (d.enroque === 'corto') === m.flags.includes('k'));
    return enr.length === 1 ? { jugada: enr[0] } : enr.length ? { ambiguas: enr.map(m => m.san) } : null;
  }

  let c = legales.filter(m => m.to === d.a);
  let estricto = false;
  if (d.pieza) c = c.filter(m => m.piece === d.pieza);
  else {
    // Sin pieza dicha: peon, como en la notacion. Si ningun peon llega, la
    // unica pieza que pueda (dicen «efe tres» y es el caballo)… salvo que se
    // haya dicho un origen: «e toma en ce cinco» es un peon, y si el peon no
    // puede no vale que lo haga el alfil.
    const peones = c.filter(m => m.piece === 'p');
    if (peones.length) c = peones;
    else estricto = !!(d.deCol || d.deFila);
  }
  const conOrigen = c.filter(m => (!d.deCol || m.from[0] === d.deCol) && (!d.deFila || +m.from[1] === d.deFila));
  if (conOrigen.length || estricto) c = conOrigen;
  if (c.some(m => m.promotion)) {
    const p = d.promo || 'q';
    c = c.filter(m => m.promotion === p);
  }
  if (c.length === 1) return { jugada: c[0] };
  if (c.length > 1) return { ambiguas: c.map(m => m.san) };
  // Se entendio una casilla pero no hay jugada asi: es ilegal, no «no te he
  // entendido». Son dos respuestas distintas para quien esta andando.
  return { ilegal: true, a: d.a };
}

/* Ordenes que no son jugadas. Se miran DESPUES de intentar la jugada. */
const ORDENES = [
  // «para» suelto es preposicion casi siempre: solo vale como orden si es
  // TODO lo que se ha dicho.
  ['parar', /^ (para|parar|paro|stop|basta)( ya)? $|\b(salir|termina|terminar|apaga|deja de escuchar)\b/],
  // Fase 38: donde esta cada pieza (el modo sin tablero).
  ['piezas', /\b(piezas|donde estan|donde esta|posicion|coordenadas|describe|describela|situacion)\b/],
  ['linea', /\b(linea|todas|toda la|todo|desde el principio|la partida|jugadas|repasa|recita)\b/],
  ['repite', /\b(repite|repitelo|repetir|otra vez|que ha jugado|que juega|que jugo|como|perdona|no te he oido)\b/],
  ['pista', /\b(pista|ayuda|ni idea|no se|no me acuerdo|me rindo)\b/],
  ['siguiente', /\b(siguiente|otra|seguir|sigue|continua|continuar|vale|venga|adelante|nueva)\b/],
];
export function vozAOrden(textos) {
  for (const t of [].concat(textos)) {
    const p = ' ' + plano(t).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    for (const [o, re] of ORDENES) if (re.test(p)) return o;
  }
  return null;
}

/* ===========================================================================
   ESCUCHAR
   =========================================================================== */
const Reconocedor = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
let navegadorRoto = false;   // el sistema lo ha negado una vez: no se insiste

export const puedeEscuchar = () =>
  !!(Reconocedor && !navegadorRoto) || !!navigator.mediaDevices?.getUserMedia;
export const viaEscucha = () => (Reconocedor && !navegadorRoto) ? 'navegador' : 'whisper';

/**
 * Escucha UNA frase. Resuelve { textos: [alternativas], via }, con textos
 * vacio si no se ha dicho nada. `senal` (AbortSignal) la corta: se descarta,
 * salvo con `enviarAlCortar` en Whisper, que manda lo que haya si hubo voz.
 */
export async function escuchar({ alParcial = null, senal = null, sugerencias = '', enviarAlCortar = false } = {}) {
  if (Reconocedor && !navegadorRoto) {
    try {
      return { textos: await reconocerNavegador({ alParcial, senal, enviarAlCortar }), via: 'navegador' };
    } catch (e) {
      // Negado por el sistema o sin servicio: a Whisper desde ya. Un permiso
      // de micro denegado por el usuario no se arregla con Whisper (tambien
      // necesita el micro), asi que ese sí se propaga.
      if (e.codigo === 'not-allowed' && !e.sistema) throw e;
      navegadorRoto = true;
    }
  }
  const texto = await escucharWhisper({ senal, sugerencias, alParcial, enviarAlCortar });
  return { textos: texto ? [texto] : [], via: 'whisper' };
}

function reconocerNavegador({ alParcial, senal, enviarAlCortar }) {
  return new Promise((ok, mal) => {
    const r = new Reconocedor();
    r.lang = 'es-ES';
    r.interimResults = !!alParcial;
    r.maxAlternatives = 5;
    r.continuous = false;
    let textos = [], acabado = false, parcial = '';
    const fin = (err) => {
      if (acabado) return;
      acabado = true;
      if (!textos.length && parcial && enviarAlCortar) textos = [parcial];
      senal?.removeEventListener('abort', cortar);
      err ? mal(err) : ok(textos);
    };
    // stop() remata y entrega lo oido hasta ahora; abort() lo tira.
    const cortar = () => {
      if (enviarAlCortar) { try { r.stop(); } catch { fin(); } return; }
      try { r.abort(); } catch { /* nada */ } fin();
    };
    r.onresult = (ev) => {
      const res = ev.results[ev.results.length - 1];
      if (res.isFinal) {
        textos = Array.from(res, a => a.transcript.trim()).filter(Boolean);
      } else { parcial = res[0].transcript.trim(); alParcial?.(parcial); }
    };
    r.onerror = (ev) => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return fin();
      const e = new Error('reconocimiento: ' + ev.error);
      e.codigo = ev.error;
      // `not-allowed` sin haber preguntado nunca suele ser el sistema (iOS en
      // modo app), no el usuario: lo distingue que no dio tiempo a preguntar.
      e.sistema = ev.error !== 'not-allowed' || (performance.now() - t0 < 400);
      fin(e);
    };
    r.onend = () => fin();
    senal?.addEventListener('abort', cortar);
    const t0 = performance.now();
    try { r.start(); } catch (e) { e.codigo = 'start'; e.sistema = true; fin(e); }
  });
}

/* --- Whisper: grabar una frase y mandarla -------------------------------- */
let flujo = null;            // el micro abierto; se reutiliza en el modo manos libres

async function microfono() {
  if (flujo && flujo.getTracks().every(t => t.readyState === 'live')) return flujo;
  flujo = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  return flujo;
}

/** Suelta el micro (el piloto rojo del movil se apaga). */
export function soltarMicro() {
  flujo?.getTracks().forEach(t => t.stop());
  flujo = null;
}

async function escucharWhisper({ senal, sugerencias, alParcial, enviarAlCortar }) {
  const wav = await grabarFrase({ senal, enviarAlCortar, alVoz: () => alParcial?.('…') });
  if (!wav) return '';
  const r = await api('voz', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: aBase64(wav), pista: sugerencias }),
  });
  return String(r.texto || '').trim();
}

/**
 * Graba hasta que se calla. Sin voz detectada en `esperaMs`, resuelve null y
 * no se manda nada. El umbral se adapta: arranca en el ruido de fondo medido
 * y la voz tiene que estar claramente por encima.
 */
export async function grabarFrase({ senal = null, esperaMs = 8000, silencioMs = 900, maxMs = 8000, alVoz = null, enviarAlCortar = false } = {}) {
  const s = await microfono();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  await ctx.resume().catch(() => {});
  const fuente = ctx.createMediaStreamSource(s);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const tasa = ctx.sampleRate;
  const trozos = [], previos = [];
  let ruido = 0.01, hablando = false, tVoz = 0, tCalla = 0, t0 = performance.now();

  return new Promise((ok) => {
    let hecho = false;
    const fin = (conAudio) => {
      if (hecho) return;
      hecho = true;
      senal?.removeEventListener('abort', cortar);
      proc.disconnect(); fuente.disconnect();
      ctx.close().catch(() => {});
      ok(conAudio && trozos.length ? wavDe(trozos, tasa) : null);
    };
    // Cortar a mano en el asistente es «ya he terminado»: se manda. En el
    // modo andando es «ya no hace falta» (tocaste el tablero, cerraste): no.
    const cortar = () => fin(hablando && enviarAlCortar);
    senal?.addEventListener('abort', cortar);

    proc.onaudioprocess = (ev) => {
      const x = new Float32Array(ev.inputBuffer.getChannelData(0));
      let e = 0;
      for (let i = 0; i < x.length; i++) e += x[i] * x[i];
      const rms = Math.sqrt(e / x.length);
      const ahora = performance.now();
      const umbral = Math.max(0.02, ruido * 3);
      if (!hablando) {
        // Se guarda un pelin de antes para no comerse la primera silaba.
        previos.push(x); if (previos.length > 3) previos.shift();
        if (rms > umbral) {
          hablando = true; tVoz = ahora; tCalla = ahora;
          trozos.push(...previos);
          alVoz?.();
        } else {
          ruido = ruido * 0.95 + rms * 0.05;
          if (ahora - t0 > esperaMs) fin(false);
        }
        return;
      }
      trozos.push(x);
      if (rms > umbral * 0.7) tCalla = ahora;
      if (ahora - tCalla > silencioMs || ahora - tVoz > maxMs) fin(true);
    };
    fuente.connect(proc);
    proc.connect(ctx.destination);
  });
}

/** Float32 a la tasa del micro → WAV mono de 16 kHz y 16 bits. */
function wavDe(trozos, tasa) {
  const n = trozos.reduce((a, t) => a + t.length, 0);
  const todo = new Float32Array(n);
  let o = 0;
  for (const t of trozos) { todo.set(t, o); o += t.length; }
  const paso = tasa / 16000, m = Math.floor(n / paso);
  const buf = new ArrayBuffer(44 + m * 2), v = new DataView(buf);
  const txt = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  txt(0, 'RIFF'); v.setUint32(4, 36 + m * 2, true); txt(8, 'WAVE');
  txt(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  txt(36, 'data'); v.setUint32(40, m * 2, true);
  for (let i = 0; i < m; i++) {
    // Media del tramo y no la muestra suelta: un filtro paso bajo de pobre,
    // suficiente para voz y sin aliasing audible.
    const a = Math.floor(i * paso), b = Math.min(n, Math.floor((i + 1) * paso));
    let s = 0; for (let k = a; k < b; k++) s += todo[k];
    s = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function aBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ===========================================================================
   PANTALLA DESPIERTA
   ===========================================================================
   Con la pantalla apagada el navegador corta el micro y la voz de una web:
   el modo andando necesita la pantalla encendida. Wake Lock la mantiene, y
   hay que volver a pedirlo al volver a la app, porque el sistema lo suelta
   solo en cuanto la pagina se oculta. */
let candado = null, quiereDespierta = false;

export async function mantenerDespierta(si) {
  quiereDespierta = si;
  if (!si) { await candado?.release().catch(() => {}); candado = null; return false; }
  if (!('wakeLock' in navigator)) return false;
  try {
    candado = await navigator.wakeLock.request('screen');
    candado.addEventListener?.('release', () => { candado = null; });
    return true;
  } catch { return false; }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (quiereDespierta && document.visibilityState === 'visible' && !candado) mantenerDespierta(true);
  });
}
