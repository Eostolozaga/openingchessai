/* ===========================================================================
   OpeningChessAI — el asistente que contesta sobre tus rivales (Fase 35).

   Dos piezas, y conviene no mezclarlas:

     1. ENTENDER. Que quieres saber, de que rival, con que color, por que
        jugadas. Lo hace un modelo pequeno en Workers AI (/api/chat), que
        devuelve una intencion en JSON. Si no hay red, se acaba el cupo o el
        modelo no contesta, lo hace `interpretarLocal()` con reglas: entiende
        las frases habituales («juego de negras contra 12345678, ¿que juega de
        blancas?», «contra e4 juego e6, ¿cual es la que mas juega?»).

     2. CONTESTAR. Siempre aqui, con datos de verdad: el analisis guardado de
        Rival (Fase 34), los cubos FIDE del movil, las partidas de Lichess y
        Chess.com. El modelo nunca pone una cifra: si dijera «70 % e4», seria
        una invencion; aqui se cuentan las partidas.

   La conversacion recuerda el rival, su color y la linea, para poder seguir
   con «¿y si juego d5?».
   =========================================================================== */

import { api, escapar, artGuardado } from './comun.js';
import { leerVario } from './almacen.js';

let conv = { rival: null, colorRival: '', linea: [] };

export function nuevaConversacion() { conv = { rival: null, colorRival: '', linea: [] }; }
export const conversacion = () => conv;

/* --- Texto y jugadas ------------------------------------------------------ */
const plano = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const RE_SAN = /(?:^|[\s.,(¿?¡!;:])((?:O-O(?:-O)?|0-0(?:-0)?)|[KQRBNCATD]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBNDTAC])?)(?=$|[\s.,)?!;:+#])/g;

/** Notacion castellana a la inglesa que usa toda la app: C, A, T, D → N, B, R, Q.
    La R se queda: en la app las jugadas salen en ingles, y ahi R es la torre. */
export function aSan(j) {
  let s = String(j).trim().replace(/[+#!?]+$/, '').replace(/^\d+\.+\s*/, '');
  if (/^0-0(-0)?$/.test(s)) s = s.replace(/0/g, 'O');
  const m = { C: 'N', A: 'B', T: 'R', D: 'Q' };
  if (m[s[0]] && /^[CATD][a-h1-8x]/.test(s)) s = m[s[0]] + s.slice(1);
  s = s.replace(/=?([DTAC])$/, (_, p) => '=' + m[p]);
  return s;
}


/* ===========================================================================
   VARIANTES POR SU NOMBRE (Fase 35b)
   ===========================================================================
   «Dentro de su Francesa, contra la Tarrasch, ¿que juega?» necesita saber que
   la Tarrasch es 1.e4 e6 2.d4 d5 3.Nd2. Eso sale de `datos/aperturas-lineas.json`
   —las 3.865 lineas con nombre de lichess-org/chess-openings (CC0), con sus
   jugadas—, y no del modelo: un modelo pequeno se sabe la Najdorf, pero no
   la Variante Guimard de la Tarrasch, y la que no sepa se la inventa.

   Los nombres estan en ingles. Lo que se escribe en castellano se traduce con
   un diccionario corto de lo que cambia («francesa», «avance», «cambio»...);
   los apellidos (Tarrasch, Winawer, Najdorf) son iguales en los dos.

   Entre varias que encajan se prefiere: la que sigue la linea de la que se
   esta hablando, despues la que tiene mas palabras de la pregunta, y despues
   la mas corta (la Tarrasch a secas antes que la Tarrasch, Variante Guimard). */
let LINEAS = null, VOCAB = null;
const GENERICAS = new Set(['defense', 'variation', 'opening', 'game', 'attack', 'gambit', 'system',
  'line', 'main', 'accepted', 'declined', 'countergambit', 'deferred', 'formation', 'with', 'the',
  'and', 'for', 'black', 'white', 'king', 'queen', 'pawn', 'knight', 'bishop', 'rook', 'two', 'three',
  'four', 'modern', 'classical', 'old', 'new', 'exchange', 'advance', 'closed', 'open']);
// Frases antes que palabras: «india de rey» tiene que llegar entera.
const ES_EN = [
  ['india de rey', 'king s indian'], ['india de dama', 'queen s indian'], ['gambito de dama', 'queen s gambit'],
  ['gambito de rey', 'king s gambit'], ['peon de dama', 'queen s pawn'], ['peon de rey', 'king s pawn'],
  ['dos caballos', 'two knights'], ['cuatro caballos', 'four knights'], ['tres caballos', 'three knights'],
  ['ruy lopez', 'ruy lopez'], ['caro kann', 'caro kann'], ['nimzoindia', 'nimzo indian'], ['nimzo india', 'nimzo indian'],
  ['bogoindia', 'bogo indian'], ['bogo india', 'bogo indian'], ['semieslava', 'semi slav'], ['semi eslava', 'semi slav'],
  ['francesa', 'french'], ['siciliana', 'sicilian'], ['espanola', 'ruy lopez'], ['italiana', 'italian'],
  ['escocesa', 'scotch'], ['inglesa', 'english'], ['holandesa', 'dutch'], ['eslava', 'slav'],
  ['catalana', 'catalan'], ['escandinava', 'scandinavian'], ['vienesa', 'vienna'], ['rusa', 'russian petrov'],
  ['moderna', 'modern'], ['clasica', 'classical'], ['cerrada', 'closed'], ['abierta', 'open'],
  ['avance', 'advance'], ['cambio', 'exchange'], ['aceptado', 'accepted'], ['rehusado', 'declined'],
  ['ataque', 'attack'], ['gambito', 'gambit'], ['sistema', 'system'], ['principal', 'main line'],
  ['dragon', 'dragon'], ['acelerado', 'accelerated'], ['acelerada', 'accelerated'], ['londres', 'london'],
  ['benoni', 'benoni'], ['grunfeld', 'grunfeld'], ['alekhin', 'alekhine'],
];
const VACIAS_ES = new Set(['de', 'la', 'el', 'los', 'las', 'su', 'sus', 'mi', 'mis', 'contra', 'dentro', 'que',
  'juega', 'juego', 'hace', 'suele', 'variante', 'apertura', 'defensa', 'linea', 'en', 'y', 'con', 'si', 'cual',
  'como', 'mas', 'del', 'al', 'un', 'una', 'por', 'esta', 'ese', 'esa', 'eso', 'le', 'lo', 'me', 'yo', 'el']);

async function cargarLineas() {
  if (LINEAS) return LINEAS;
  const d = await fetch('/datos/aperturas-lineas.json').then(r => r.json());
  VOCAB = new Set();
  LINEAS = d.map(([eco, n, j]) => {
    const t = new Set(plano(n).split(' '));
    for (const x of t) if (x.length >= 4 && !GENERICAS.has(x)) VOCAB.add(x);
    return { eco, n, j: j.split(' '), t };
  });
  return LINEAS;
}

/** Las palabras de la pregunta, en el ingles de los nombres. */
function palabrasVariante(texto, quitar = '') {
  let q = ' ' + plano(texto) + ' ';
  for (const w of plano(quitar).split(' ').filter(x => x.length > 2)) q = q.replace(' ' + w + ' ', ' ');
  for (const [es, en] of ES_EN) q = q.replace(new RegExp(` ${es} `, 'g'), ` ${en} `);
  return q.split(' ').filter(w => w && !VACIAS_ES.has(w));
}

export async function buscarVariante(texto, actual = [], quitar = '') {
  const lineas = await cargarLineas().catch(() => null);
  if (!lineas) return null;
  const ps = palabrasVariante(texto, quitar);
  const fuertes = ps.filter(p => VOCAB.has(p));
  // Sin un nombre propio, solo vale una palabra generica («avance», «cambio»,
  // «cerrada») DENTRO de la apertura de la que se habla: «¿y contra la del
  // avance?» con la Francesa en la mesa es la Francesa del Avance.
  const genericas = fuertes.length ? [] : ps.filter(p => GENERICAS.has(p) && p.length >= 4);
  if (!fuertes.length && (!genericas.length || actual.length < 2)) return null;
  const comun = (j) => { let k = 0; while (k < j.length && k < actual.length && j[k] === actual[k]) k++; return k; };
  if (!fuertes.length) {
    // Solo palabras genericas: la variante de ESA apertura. La familia es el
    // nombre (hasta los dos puntos) de la linea con nombre mas larga por la que
    // pasa la conversacion: con la Tarrasch en la mesa, «French Defense»; y
    // «la del avance» es la French Defense: Advance Variation, la mas corta de
    // esa familia con esa palabra, no la «Advance Line» de dentro de la Tarrasch.
    let fam = null;
    for (const l of lineas) {
      if (l.j.length <= actual.length && comun(l.j) === l.j.length && (!fam || l.j.length > fam.j.length)) fam = l;
    }
    const familia = fam ? fam.n.split(':')[0] : null;
    if (!familia) return null;
    let corta = null;
    for (const l of lineas) {
      if (l.n.split(':')[0] !== familia || !genericas.every(p => l.t.has(p))) continue;
      if (!corta || l.j.length < corta.j.length) corta = l;
    }
    return corta;
  }
  let mejor = null;
  for (const l of lineas) {
    if (fuertes.length ? !fuertes.every(p => l.t.has(p)) : !genericas.every(p => l.t.has(p))) continue;
    const c = comun(l.j);
    if (!fuertes.length && c < 2) continue;
    const toca = ps.filter(p => l.t.has(p)).length;
    // Primero la que comparte mas con la linea de la conversacion, luego la
    // que tiene mas palabras de la pregunta, y luego la mas corta.
    const nota = c * 1000 + toca * 10 - l.j.length / 100;
    if (!mejor || nota > mejor.nota) mejor = { ...l, nota };
  }
  return mejor;
}

/* «¿Y despues?», «sigue»: la linea avanza por lo que mas juega EL y por tu
   respuesta —la de tu repertorio si la tienes; si no, la que mas le hacen—. */
const RE_SEGUIR = /\b(y despues|y luego|y ahora|sigue|sigamos|continua|siguiente)\b/;

async function tuRespuesta(linea, colorRival) {
  try {
    const { fuentesDelRepertorio } = await import('./comun.js');
    const rep = await fuentesDelRepertorio();
    const mias = colorRival === 'negras' ? rep.blancas : rep.negras;
    const votos = new Map();
    for (const f of mias) {
      if (!f.arbol) continue;
      let n = 0, ok = true;
      for (const s of linea) {
        const h = (f.arbol.hijos[n] || []).find(x => f.arbol.san[x] === s);
        if (h === undefined) { ok = false; break; }
        n = h;
      }
      if (!ok) continue;
      for (const h of f.arbol.hijos[n] || []) {
        votos.set(f.arbol.san[h], (votos.get(f.arbol.san[h]) || 0) + (f.arbol.frec[h] || 1));
      }
    }
    const top = [...votos.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  } catch { return null; }
}

/* Palabras de las preguntas que nunca son parte de un nombre. */
const COMANDOS = new Set([...VACIAS_ES, 'quien', 'quiero', 'saber', 'dime', 'decir', 'rival', 'jugador',
  'contra', 'blancas', 'negras', 'blanca', 'negra', 'color', 'abre', 'abrelo', 'abrir', 'analiza', 'analizar',
  'busca', 'buscar', 'partidas', 'partida', 'primera', 'jugada', 'jugadas', 'responde', 'contesta', 'sale',
  'salida', 'hueco', 'huecos', 'repertorio', 'mio', 'mia', 'despues', 'luego', 'ahora', 'sigue', 'siguiente',
  'tiene', 'tengo', 'hay', 'para', 'sobre', 'cuantas', 'cuanto', 'cuando', 'donde', 'porque', 'por', 'hacer',
  'normalmente', 'habitualmente', 'siempre', 'mucho', 'otra', 'otro', 'pues', 'vale', 'gracias', 'hola',
  'favor', 'puedes', 'podrias', 'quieres', 'fide', 'lichess', 'chesscom', 'chess', 'com', 'ficha', 'numero',
  'apertura', 'aperturas', 'variante', 'variantes', 'defensa', 'gambito', 'ataque', 'sistema', 'francesa',
  'siciliana', 'espanola', 'italiana', 'escocesa', 'inglesa', 'holandesa', 'eslava', 'catalana', 'india',
  'escandinava', 'moderna', 'avance', 'cambio', 'clasica', 'cerrada', 'abierta', 'principal', 'linea']);

/* ===========================================================================
   ENTENDER SIN MODELO
   =========================================================================== */
export function interpretarLocal(texto) {
  const t = plano(texto);
  const o = { accion: 'no_se', fide: '', nombre: '', lichess: '', chesscom: '',
              color_rival: '', jugadas: [], continuar: false, pestana: '', consulta: '',
              variante: '', seguir: RE_SEGUIR.test(t) };

  const fide = String(texto).match(/\b(\d{5,10})\b/);
  if (fide) o.fide = fide[1];
  const li = String(texto).match(/lichess(?:\.org)?\s+(?:de\s+|usuario\s+)?@?([\w-]{2,30})/i);
  if (li) o.lichess = li[1];
  const cc = String(texto).match(/chess\.?com\s+(?:de\s+|usuario\s+)?@?([\w-]{3,25})/i);
  if (cc) o.chesscom = cc[1];

  // Colores. «Juego de negras» es MI color: el rival lleva el otro.
  const mio = t.match(/\b(?:juego|llevo|voy)\s+(?:de|con)\s+(blancas|negras)\b/);
  const suyo = t.match(/\b(?:juega|lleva|abre|sale|hace)\s+(?:el\s+)?(?:de|con)\s+(blancas|negras)\b/)
            || t.match(/\b(?:sus|las)\s+(?:partidas\s+)?(?:de|con)\s+(blancas|negras)\b/);
  // «¿Y de blancas?», «con negras contra e4»: sin verbo, el color es el suyo.
  const suelto = !mio && t.match(/\b(?:de|con)\s+(blancas|negras)\b/);
  if (suyo) o.color_rival = suyo[1];
  else if (mio) o.color_rival = mio[1] === 'blancas' ? 'negras' : 'blancas';
  else if (suelto) o.color_rival = suelto[1];

  for (const m of String(texto).matchAll(RE_SAN)) o.jugadas.push(aSan(m[1]));

  // Un nombre con coma, como en la ficha FIDE: «apellido apellido, nombre».
  // Se quitan las palabras de la pregunta que vayan pegadas delante y detras.
  const coma = String(texto).match(/([A-Za-zÀ-ÿ'’\- ]{3,}),\s*([A-Za-zÀ-ÿ'’\- ]{2,})/);
  if (coma) {
    const delante = plano(coma[1]).split(' ').filter(w => !COMANDOS.has(w));
    const detras = [];
    for (const w of plano(coma[2]).split(' ')) { if (COMANDOS.has(w)) break; detras.push(w); }
    if (delante.length && detras.length) o.nombre = `${delante.join(' ')}, ${detras.join(' ')}`;
  }
  // Sin coma, lo que sobra al quitar todo lo demas puede ser un nombre
  // («¿que juega garcia lopez?»). Solo es un candidato: responder() lo busca
  // en el indice y, si no hay nadie asi, lo olvida sin decir nada.
  if (!o.nombre && !o.fide && !o.lichess && !o.chesscom) {
    const resto = plano(texto).split(' ')
      .filter(w => w.length >= 3 && !COMANDOS.has(w) && !/\d/.test(w) && !/^[a-h][1-8]$/.test(w));
    if (resto.length >= 2 && resto.length <= 5) o.nombreSuave = resto.join(' ');
  }
  o.continuar = o.jugadas.length > 0 && /^\s*[¿]?\s*y\b/i.test(texto);

  const tabs = { inicio: 'inicio', cursos: 'cursos', repertorio: 'rep', rival: 'rival',
                 analisis: 'analisis', fichas: 'fichas', entrenar: 'train', entrena: 'train', blind: 'blind', ciegas: 'blind' };
  const ir = t.match(/\b(?:llevame|ir|vamos|abre(?:me)?)\s+(?:a\s+)?(?:la\s+)?(?:pestana\s+)?(?:de\s+)?(inicio|cursos|repertorio|analisis|fichas|entrenar|entrena|blind|ciegas)\b/);

  if (/\b(hueco|huecos|me saca|se sale|preparar|me falta|fuera de mi)\b/.test(t)) o.accion = 'huecos';
  else if (ir) { o.accion = 'ir'; o.pestana = tabs[ir[1]]; }
  else if (/\b(abre(lo)?|abrir|analiza(lo)?|analizar)\b/.test(t) && !o.jugadas.length) o.accion = 'abrir_rival';
  else if (/\b(aperturas|perfil|estilo|como juega|repertorio de)\b/.test(t)) o.accion = 'resumen_rival';
  else if (o.jugadas.length || o.fide || o.lichess || o.chesscom || o.color_rival || o.seguir
           || /\b(juega|suele|responde|contesta|mas juega|que hace|sale con|variante)\b/.test(t)) o.accion = 'jugadas_rival';
  else { o.accion = 'ayuda'; o.consulta = texto; }
  return o;
}

/* ===========================================================================
   ENTENDER CON MODELO
   =========================================================================== */
async function entender(texto) {
  const local = interpretarLocal(texto);
  try {
    const r = conv.rival;
    const { intencion: m } = await api('chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mensaje: texto, contexto: {
        rival: r ? `${r.nombre}${r.fuente === 'fide' ? ` (FIDE ${r.id})` : ` (${r.fuente} ${r.id})`}` : '',
        color_rival: conv.colorRival, linea: conv.linea } }),
    });
    // Lo que el modelo no ha visto y las reglas si (un numero de ficha, unas
    // jugadas), se rellena con las reglas: un modelo pequeno a veces se deja
    // un campo, y el texto esta ahi.
    const x = { ...m, jugadas: (m.jugadas || []).map(aSan) };
    for (const k of ['fide', 'lichess', 'chesscom', 'color_rival']) if (!x[k] && local[k]) x[k] = local[k];
    x.seguir = !!(x.seguir || local.seguir);
    if (!x.nombre && !x.fide && local.nombre) x.nombre = local.nombre;
    x.nombreSuave = local.nombreSuave || '';
    if (!x.jugadas.length && local.jugadas.length) { x.jugadas = local.jugadas; x.continuar = local.continuar; }
    if (x.accion === 'no_se' && local.accion !== 'ayuda') x.accion = local.accion;
    return { ...x, modelo: true };
  } catch {
    return { ...local, modelo: false };
  }
}

/* ===========================================================================
   CONTESTAR
   ===========================================================================
   Devuelve { html, acciones } — `acciones` son los botones de la respuesta:
     { txt, tipo: 'rival'|'ir'|'elegir'|'preguntar'|'explorador', ... } */
export async function responder(texto, { rivalElegido = null } = {}) {
  const i = await entender(texto);
  // Viene de pulsar uno de los «¿cuál es?»: el rival ya esta decidido y no se
  // vuelve a buscar por el nombre, que daria la misma lista otra vez.
  if (rivalElegido) { conv.rival = null; Object.assign(i, { fide: '', nombre: '', lichess: '', chesscom: '' }); }
  const pie = i.modelo ? '' : '<span class="asis-nota">sin conexión con el modelo: entendido con reglas</span>';

  // Con un rival en la conversacion, «¿y contra la Winawer?» o «¿y de
  // blancas?» siguen hablando de el, aunque no lleven «juega».
  if (conv.rival && (i.accion === 'ayuda' || i.accion === 'no_se')) {
    const sigueConEl = /^\s*¿?\s*y\b/i.test(texto) || i.color_rival || i.seguir ||
      await buscarVariante(texto, conv.linea, conv.rival.nombre);
    if (sigueConEl) i.accion = 'jugadas_rival';
  }

  if (i.accion === 'ir') {
    return { html: `Te llevo a <b>${escapar(nombreTab(i.pestana))}</b>.`, acciones: [], ir: i.pestana };
  }
  if (i.accion === 'ayuda' || (i.accion === 'no_se' && !conv.rival && !i.fide && !i.nombre)) {
    return { ayuda: i.consulta || texto, html: '', acciones: [], pie };
  }

  // --- El rival --------------------------------------------------------
  const antes = conv.rival;
  const nuevo = rivalElegido || await resolverRival(i);
  if (nuevo?.elegir) {
    return {
      html: nuevo.dudoso
        ? `No encuentro a nadie con ese nombre exacto. ¿Es ${nuevo.elegir.length === 1 ? 'este' : 'alguno de estos'}?`
        : `Hay ${nuevo.elegir.length} jugadores con ese nombre. ¿Cuál es?`,
      acciones: nuevo.elegir.map(r => ({ txt: `${r.nombre} · ${r.sub}`, tipo: 'elegir', rival: r, texto })),
      pie,
    };
  }
  if (nuevo?.error) return { html: escapar(nuevo.error), acciones: [], pie };
  if (nuevo) conv.rival = nuevo;
  if (!conv.rival) {
    return { html: '¿De qué rival? Dime su número de ficha FIDE, su nombre o su usuario de ' +
                   'Lichess o Chess.com.', acciones: [], pie };
  }
  const cambioRival = !antes || antes.id !== conv.rival.id || antes.fuente !== conv.rival.fuente;

  // --- Color y linea ---------------------------------------------------
  let valida, avisoLinea = '';
  const variante = !cambioRival || !i.jugadas.length
    ? await buscarVariante(i.variante || texto, cambioRival ? [] : conv.linea, conv.rival?.nombre || '')
    : null;
  if (i.seguir && !i.jugadas.length && !variante && !cambioRival && conv.ultimaTop) {
    // Avanza por lo que mas juega el y por tu respuesta.
    const suya = [...conv.linea, conv.ultimaTop];
    const mia = await tuRespuesta(suya, conv.colorRival);
    let resp = mia;
    if (!resp) {
      const c = await partidasDe(conv.rival);
      const lado0 = conv.colorRival === 'negras' ? 'black' : 'white';
      resp = c.partidas ? siguientes(c.partidas, lado0, suya).filas[0]?.san : null;
    }
    valida = await validarLinea(resp ? [...suya, resp] : suya);
    avisoLinea = resp
      ? `Sigo por su ${escapar(numeradas([conv.ultimaTop], conv.linea.length))} y ` +
        (mia ? `tu repertorio: <b class="mono">${escapar(numeradas([resp], suya.length))}</b>.`
             : `lo que más le juegan: <b class="mono">${escapar(numeradas([resp], suya.length))}</b> (no lo tienes en tu repertorio).`)
      : '';
  } else if (variante) {
    // La variante por su nombre, y si ademas ha dicho jugadas, detras.
    valida = await validarLinea([...variante.j, ...i.jugadas]);
    if (valida.error) valida = await validarLinea(variante.j);
    avisoLinea = `<span class="asis-nota">${escapar(variante.n)}: ${escapar(numeradas(variante.j))}</span>`;
  } else if (i.continuar && !cambioRival && conv.linea.length && conv.colorRival) {
    // Con el color del rival sabido, «¿y si juego d5?» es TU jugada: si en la
    // linea guardada le toca a el, lo nuevo sustituye a tu ultima jugada.
    const mueveEl = (n) => (n % 2 === 0) === (conv.colorRival === 'blancas');
    const base = mueveEl(conv.linea.length) ? conv.linea.slice(0, -1) : conv.linea;
    valida = await validarLinea([...base, ...i.jugadas]);
  } else if (i.continuar && !cambioRival && conv.linea.length) {
    // «¿Y si juego d5?» despues de 1.e4 e6 no es seguir la linea, es CAMBIAR
    // tu ultima jugada. Se prueba primero a seguir y, si no es legal, a
    // sustituir la ultima: la que sea legal es la que querias decir.
    valida = await validarLinea([...conv.linea, ...i.jugadas]);
    if (valida.error) {
      const otra = await validarLinea([...conv.linea.slice(0, -i.jugadas.length || -1), ...i.jugadas]);
      if (!otra.error) valida = otra;
    }
  } else {
    valida = await validarLinea(i.jugadas.length ? i.jugadas
      : (cambioRival || i.color_rival) ? [] : conv.linea);
  }
  if (valida.error) return { html: escapar(valida.error), acciones: [], pie };
  let linea = valida.sanes;

  let color = i.color_rival || (cambioRival ? '' : conv.colorRival);
  // Con jugadas y sin color, la pregunta es casi siempre «¿y aqui que juega?»:
  // el color del rival es el del que mueve en esa posicion.
  if (!color && linea.length && i.accion === 'jugadas_rival') color = linea.length % 2 === 0 ? 'blancas' : 'negras';
  if (!linea.length) conv.ultimaTop = null;
  conv.colorRival = color;
  conv.linea = linea;

  const cargadas = await partidasDe(conv.rival);
  if (cargadas.error) return { html: escapar(cargadas.error), acciones: [], pie };
  const lado = color === 'negras' ? 'black' : color === 'blancas' ? 'white' : '';
  const abrir = { txt: linea.length ? 'Ver esta línea en Rival' : 'Abrir en Rival', tipo: 'rival',
                  rival: conv.rival, lado: lado || null, linea };

  if (i.accion === 'huecos') return { ...huecos(cargadas, abrir), pie };
  if (i.accion === 'resumen_rival') return { ...resumen(cargadas, lado, abrir), pie };
  if (i.accion === 'abrir_rival') return { html: `Abro a <b>${escapar(conv.rival.nombre)}</b> en Rival.`, acciones: [], abrir, pie };
  const r = estadisticas(cargadas, lado, linea, abrir);
  // El nombre de la posicion, si la tabla de aperturas lo tiene: «French
  // Defense: Tarrasch Variation». Se pone delante de la respuesta, que es
  // donde uno lo busca para saber de que se esta hablando.
  let nombre = '';
  if (linea.length && !variante) {
    try {
      const { nombrarLinea } = await import('./aperturas.js');
      const { Chess } = await import('./vendor/chess.js');
      const a = await nombrarLinea(Chess, linea);
      if (a) nombre = `<span class="asis-nota">${escapar(a.eco)} · ${escapar(a.nombre)}</span><br>`;
    } catch { /* sin nombre */ }
  }
  return { ...r, html: (avisoLinea ? avisoLinea + '<br>' : '') + nombre + r.html, pie };
}

const nombreTab = (t) => ({ inicio: 'Inicio', cursos: 'Cursos', rep: 'Repertorio', rival: 'Rival',
  analisis: 'Análisis', fichas: 'Fichas', train: 'Entrenar' })[t] || t;

/* --- Quien es el rival ---------------------------------------------------- */
async function resolverRival(i) {
  if (i.fide) {
    const meta = await metaFide().catch(() => null);
    let nombre = `Ficha ${i.fide}`, sub = '';
    if (meta) {
      const cubo = await artGuardado(`rivales/jugadores/${Number(i.fide) % (meta.cubos || 2048)}.json.gz`, meta.generado).catch(() => ({}));
      const j = cubo[i.fide];
      if (j) { nombre = j.n || nombre; sub = [j.fed, j.e && `${j.e} Elo`].filter(Boolean).join(' · '); }
    }
    return { fuente: 'fide', id: i.fide, nombre, sub };
  }
  if (i.lichess) return { fuente: 'lichess', id: i.lichess, nombre: i.lichess, sub: 'Lichess' };
  if (i.chesscom) return { fuente: 'chesscom', id: i.chesscom, nombre: i.chesscom, sub: 'Chess.com' };
  if (i.nombre) return buscarPorNombre(i.nombre);
  if (i.nombreSuave) {
    const r = await buscarPorNombre(i.nombreSuave, { suave: true });
    if (r && !r.error) return r;
  }
  return null;
}

let meta = null;
async function metaFide() {
  if (!meta) meta = await api('art/rivales/meta.json.gz');
  return meta;
}

/** El mismo indice que el buscador de Rival: solo quien tiene partidas. */
async function buscarPorNombre(nombre, { suave = false } = {}) {
  const q = plano(nombre).replace(/ +/g, ' ');
  if (q.length < 3) return { error: 'Dime algo más del nombre, o su número de ficha FIDE.' };
  const m = await metaFide().catch(() => null);
  if (!m) return { error: 'Sin conexión no puedo buscar jugadores por nombre.' };
  const palabras = q.split(' ');
  // El indice esta troceado por la primera letra del APELLIDO, que es como
  // va la ficha. Si se escribe «nombre apellido», el nombre de pila va
  // delante: se mira en la letra de cada palabra, como mucho tres.
  const letras = [...new Set(palabras.map(p => (/[a-z]/.test(p[0]) ? p[0] : '0')))].slice(0, 3);
  const filas = (await Promise.all(letras.map(l =>
    artGuardado(`rivales/indice/${l}.json.gz`, m.generado).catch(() => [])))).flat();
  const vistos = new Set();
  const unicas = filas.filter(f => !vistos.has(String(f[1])) && vistos.add(String(f[1])));
  const tiene = (f, p) => (' ' + plano(f[0]).replace(/ +/g, ' ')).includes(' ' + p);
  let encaja = unicas.filter(f => palabras.every(p => tiene(f, p)));
  // Una errata («carlsem» por «carlsen»): si con todas las palabras no
  // sale nadie, valen todas menos una, con al menos dos. Se ofrecen como
  // candidatos para que elijas, nunca se da uno por bueno solo.
  let dudoso = false;
  if (!encaja.length && palabras.length >= 3) {
    encaja = unicas.filter(f => palabras.filter(p => tiene(f, p)).length >= palabras.length - 1);
    dudoso = encaja.length > 0;
  }
  const exacto = encaja.filter(f => plano(f[0]).replace(/ +/g, ' ') === q);
  const lista = exacto.length === 1 ? exacto : encaja;
  if (dudoso) {
    if (suave && !lista.length) return null;
    return { elegir: lista.slice(0, 6).map(f => ({ fuente: 'fide', id: String(f[1]),
      nombre: f[0].replace(/\b\w/g, c => c.toUpperCase()),
      sub: [f[2], f[3] && `${f[3]} Elo`, `${f[5]} partidas`].filter(Boolean).join(' · ') })), dudoso: true };
  }
  if (suave && !lista.length) return null;
  const fila = (f) => ({ fuente: 'fide', id: String(f[1]), nombre: f[0].replace(/\b\w/g, c => c.toUpperCase()),
                         sub: [f[2], f[3] && `${f[3]} Elo`, `${f[5]} partidas`].filter(Boolean).join(' · ') });
  if (!lista.length) return { error: `No encuentro a nadie con partidas que se llame «${nombre}». Prueba con su número de ficha FIDE.` };
  if (lista.length === 1) return fila(lista[0]);
  return { elegir: lista.slice(0, 6).map(fila) };
}

/* --- Sus partidas --------------------------------------------------------
   Primero lo que ya se analizo en Rival (partidas saneadas, Fase 34); si no,
   las de siempre: el cubo FIDE guardado en el movil, o Lichess / Chess.com. */
async function partidasDe(r) {
  const pref = r.fuente === 'fide' ? `rv:fide:${r.id}`
             : r.fuente === 'lichess' ? `rv:li:${r.id.toLowerCase()}:` : `rv:cc:${r.id.toLowerCase()}:`;
  const lista = (await leerVario('rv:lista'))?.claves || [];
  const clave = lista.find(k => k === pref || k.startsWith(pref));
  if (clave) {
    const g = await leerVario(clave);
    if (g?.datos?.partidas?.length) {
      if (g.perfil?.nombre) r.nombre = g.perfil.nombre;
      return { partidas: g.datos.partidas, analisis: g.datos, guardado: g.en };
    }
  }
  try {
    if (r.fuente === 'fide') {
      const m = await metaFide();
      const { convertirFide } = await import('./partidas.js');
      const cubo = await artGuardado(`rivales/jugadores/${Number(r.id) % (m.cubos || 2048)}.json.gz`, m.generado);
      const j = cubo[r.id];
      if (!j?.g?.length) return { error: `${r.nombre} no tiene partidas en la base FIDE.` };
      return { partidas: j.g.map((x, k) => convertirFide(x, r.id + '-' + k)) };
    }
    if (r.fuente === 'lichess') {
      const { partidasLichessRival } = await import('./partidas.js');
      const { partidas } = await partidasLichessRival(r.id, { max: 300 });
      return partidas.length ? { partidas } : { error: `${r.id} no tiene partidas en Lichess.` };
    }
    const { bajarPartidasChesscom } = await import('./chesscom.js');
    const partidas = await bajarPartidasChesscom(r.id, 300, null, () => {});
    return partidas.length ? { partidas } : { error: `${r.id} no tiene partidas en Chess.com.` };
  } catch (e) {
    return { error: `No he podido traer sus partidas: ${e.message}` };
  }
}

async function validarLinea(sanes) {
  if (!sanes.length) return { sanes: [] };
  const { Chess } = await import('./vendor/chess.js');
  const ch = new Chess();
  const fuera = [];
  for (const s of sanes) {
    let h = null;
    try { h = ch.move(s); } catch { h = null; }
    if (!h) {
      return { error: `«${s}» no es una jugada legal después de ${fuera.length ? numeradas(fuera) : 'la posición inicial'}.` };
    }
    fuera.push(h.san);
  }
  return { sanes: fuera };
}

/* --- Las respuestas ------------------------------------------------------- */
const numeradas = (sanes, desde = 0) => sanes.map((s, k) => {
  const i = desde + k;
  return i % 2 === 0 ? `${i / 2 + 1}.${s}` : (k === 0 ? `${(i - 1) / 2 + 1}…${s}` : s);
}).join(' ');
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const colorTxt = (lado) => lado === 'white' ? 'blancas' : 'negras';

/* Las partidas del cubo sin pasar por el saneo pueden traer basura («}», una
   jugada en algebraica larga): esa partida no cuenta en esa posicion. */
const SAN_OK = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?$/;

function siguientes(partidas, lado, linea) {
  const L = linea.length;
  const conteo = new Map();
  let n = 0;
  for (const p of partidas) {
    if (lado && p.ladoRival !== lado) continue;
    const s = p.sanes || [];
    if (s.length <= L || !SAN_OK.test(s[L])) continue;
    let ok = true;
    for (let k = 0; k < L; k++) if (s[k] !== linea[k]) { ok = false; break; }
    if (!ok) continue;
    n++;
    const j = s[L];
    const c = conteo.get(j) || { san: j, n: 0, puntos: 0 };
    c.n++; c.puntos += p.puntos ?? 0.5;
    conteo.set(j, c);
  }
  return { n, filas: [...conteo.values()].sort((a, b) => b.n - a.n) };
}

function tablaHTML(filas, n, desde) {
  return `<div class="asis-tabla">${filas.slice(0, 5).map(f => `
    <div class="asis-fila"><b class="mono">${escapar(numeradas([f.san], desde))}</b>
      <span>${pct(f.n, n)} %</span><span class="asis-nota">${f.n} ${f.n === 1 ? 'partida' : 'partidas'} · puntúa ${pct(f.puntos, f.n)} %</span></div>`).join('')}
    ${filas.length > 5 ? `<div class="asis-nota">y ${filas.length - 5} jugadas más</div>` : ''}</div>`;
}

function estadisticas({ partidas }, lado, linea, abrir) {
  const r = conv.rival;
  const quien = `<b>${escapar(r.nombre)}</b>`;
  if (!lado && !linea.length) {
    // Sin color: los dos. Con blancas, su primera jugada; con negras, lo que
    // contesta a las primeras jugadas que mas le hacen.
    const b = siguientes(partidas, 'white', []);
    const contra = siguientes(partidas, 'black', []).filas.slice(0, 3).map(o => {
      const r2 = siguientes(partidas, 'black', [o.san]);
      const t = r2.filas[0];
      return t ? `<div class="asis-fila"><span class="mono">contra 1.${escapar(o.san)}</span>` +
        `<b class="mono">…${escapar(t.san)}</b><span class="asis-nota">${pct(t.n, r2.n)} % de ${r2.n}</span></div>` : '';
    }).join('');
    return {
      html: `${quien}${r.sub ? ` <span class="asis-nota">${escapar(r.sub)}</span>` : ''}<br>` +
        `<b>Con blancas</b> (${b.n} partidas):${tablaHTML(b.filas, b.n, 0)}` +
        (contra ? `<b>Con negras</b>:<div class="asis-tabla">${contra}</div>` : '') +
        `<span class="asis-nota">Dime con qué color juegas tú, o una línea («contra e4 juego e6»).</span>`,
      acciones: [abrir],
    };
  }
  const s = siguientes(partidas, lado, linea);
  const donde = linea.length ? `tras <span class="mono">${escapar(numeradas(linea))}</span>` : 'en la primera jugada';
  const total = partidas.filter(p => !lado || p.ladoRival === lado).length;
  if (!s.n) {
    const primeras = siguientes(partidas, lado, []);
    return {
      html: `En sus ${total} partidas con ${colorTxt(lado)}, ${quien} no ha llegado nunca a la posición ${donde}.` +
        (primeras.n ? `<br>Lo que sí juega de primeras:${tablaHTML(primeras.filas, primeras.n, 0)}` : ''),
      acciones: [abrir],
    };
  }
  // ¿A quien le toca? Si mueve el rival, es SU eleccion; si no, es lo que le
  // han jugado a el, que tambien sirve, pero hay que decirlo.
  const mueveEl = (linea.length % 2 === 0) === (lado === 'white');
  const top = s.filas[0];
  conv.ultimaTop = mueveEl ? top.san : null;
  return {
    html: `${quien}, con ${colorTxt(lado)}, ${donde} (${s.n} de ${total} partidas):` +
      tablaHTML(s.filas, s.n, linea.length) +
      (mueveEl
        ? `La que más juega es <b class="mono">${escapar(numeradas([top.san], linea.length))}</b> (${pct(top.n, s.n)} %).`
        : `<span class="asis-nota">Ahí no mueve él: es lo que le han jugado sus rivales.</span>`),
    acciones: [abrir, { txt: 'Verla en el explorador', tipo: 'explorador', linea: [...linea, top.san], girado: lado === 'white' }],
  };
}

function resumen({ partidas, analisis }, lado, abrir) {
  const r = conv.rival;
  const lineas = [];
  const et = analisis?.estilo;
  if (et?.blancas?.etiqueta) lineas.push(`Con blancas: ${escapar(et.blancas.etiqueta)}.`);
  if (et?.negras?.etiqueta) lineas.push(`Con negras: ${escapar(et.negras.etiqueta)}.`);
  const bloques = (analisis?.bloques || []).filter(b => !lado || b.side === lado).slice(0, 4);
  return {
    html: `<b>${escapar(r.nombre)}</b> · ${partidas.length} partidas<br>` +
      (lineas.length ? lineas.join('<br>') : '') +
      (bloques.length
        ? `<div class="asis-tabla">${bloques.map(b => `<div class="asis-fila"><b>${escapar(b.nombre)}</b>` +
            `<span>${b.n}</span><span class="asis-nota">con ${colorTxt(b.side)} · puntúa ${b.score} %</span></div>`).join('')}</div>`
        : (analisis ? '' : '<br><span class="asis-nota">El reparto por aperturas sale del análisis: ábrelo en Rival y te lo cuento con detalle la próxima vez.</span>')),
    acciones: [abrir],
  };
}

function huecos({ analisis }, abrir) {
  const r = conv.rival;
  if (!analisis) {
    return { html: `Para saber dónde se sale <b>de tu repertorio</b> hay que cruzar sus partidas con tus cursos. ` +
                   `Ábrelo en Rival (una vez cruzado, queda guardado y te lo cuento aquí).`,
             acciones: [{ ...abrir, txt: 'Cruzarlo en Rival', linea: [], vista: 'contra' }] };
  }
  const grupos = (analisis.contra || []).filter(g => g.huecos?.length).slice(0, 3);
  if (!grupos.length) {
    return { html: `<b>${escapar(r.nombre)}</b> no se sale de tu repertorio en ninguna posición que ya haya jugado.`, acciones: [abrir] };
  }
  return {
    html: `Donde <b>${escapar(r.nombre)}</b> juega algo que no tienes:` + grupos.map(g => {
      const h = g.huecos[0];
      return `<div class="asis-fila"><b>${escapar(g.nombre)}</b><span class="mono">${escapar(numeradas([...h.linea, h.san]))}</span>` +
             `<span class="asis-nota">${h.veces} ${h.veces === 1 ? 'vez' : 'veces'}${g.huecos.length > 1 ? ` · y ${g.huecos.length - 1} más` : ''}</span></div>`;
    }).join(''),
    acciones: [{ ...abrir, txt: 'Ver todos en Rival', linea: [], vista: 'contra' }],
  };
}
