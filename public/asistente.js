/* ===========================================================================
   OpeningChessAI — el asistente de la burbuja.

   Un ayudante que responde SIN modelo de lenguaje. No es una limitacion
   disimulada: para «como subo un PGN» y «que es la Najdorf», un indice bien
   escrito contesta en veinte milisegundos, funciona sin cobertura y no cuesta
   nada. Un modelo, ademas de tardar y costar, se inventaria funciones que la
   app no tiene, que es el peor fallo posible en una pantalla de ayuda.

   Tres fuentes, por orden de precision:
     1. datos/ayuda.json          — treinta temas escritos a mano sobre la app.
     2. datos/aperturas-guia.json — 69 aperturas con nombre en castellano y sus
        jugadas. Todas verificadas contra la tabla de aperturas: si una linea
        no daba nombre real, no entro.
     3. datos/aperturas.json      — las 3.810 restantes, solo por nombre. Sin
        jugadas: de un EPD no se puede volver a la partida que lleva hasta el.

   FASE 35: Y AHORA TAMBIEN CONVERSA. Mientras escribes, el indice de siempre
   va enseñando temas y aperturas como antes. Al ENVIAR (Intro o la flecha),
   el mensaje va a chat.js, que entiende la pregunta con un modelo pequeño en
   Workers AI —o con reglas, sin red— y contesta con los datos de tus rivales.
   Las dudas sobre la app que llegan por ahi se siguen contestando con el
   indice: el modelo no escribe ayuda, la busca.
   =========================================================================== */

import { $, escapar } from './comun.js';
import { puedeEscuchar, escuchar, desbloquearAudio, hablar, callar, textoAVoz, soltarMicro } from './voz.js';

let montado = false;
let volverA = null;        // como estaba la lista antes de entrar en un detalle
let AYUDA = null, GUIA = null, TABLA = null;
let irAPestana = () => {};
let charla = [];           // [{ yo } | { bot: html, acciones }]; vacia = modo indice
let oyendo = null;         // AbortController de la escucha en curso (Fase 37)

/* --- Texto ---------------------------------------------------------------
   Sin acentos y en minusculas. Quien escribe con el pulgar en el metro no pone
   la dieresis de Grunfeld, y exigirsela seria una forma tonta de no encontrar
   nada. */
const plano = (s) => String(s ?? '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9+]+/g, ' ').trim();

/* Palabras que no distinguen nada. Sin esta lista, «que es el repertorio»
   encuentra la Escocesa por el «es», y «como subo un pgn» encuentra la
   GrUNfeld por el «un». Si la pregunta entera son palabras de estas, se usan
   igualmente: mas vale buscar mal que no buscar. */
const VACIAS = new Set(['a', 'al', 'como', 'con', 'cual', 'cuales', 'de', 'del',
  'donde', 'e', 'el', 'en', 'es', 'esta', 'este', 'hay', 'la', 'las', 'lo',
  'los', 'me', 'mi', 'mis', 'no', 'o', 'para', 'por', 'puedo', 'que', 'se', 'si',
  'su', 'sus', 'te', 'tu', 'tus', 'un', 'una', 'uno', 'y']);

function palabrasDe(q) {
  const t = plano(q).split(' ').filter(Boolean);
  const u = t.filter(p => p.length > 1 && !VACIAS.has(p));
  return u.length ? u : t;
}

/* Coincide por PRINCIPIO de palabra y no por trozo suelto, que es la
   diferencia entre buscar «tema» y que salga el SisTEMA Londres. */
const hay = (texto, p) => (' ' + texto).includes(' ' + p);

async function datos() {
  if (AYUDA && GUIA) return;
  const leer = (u) => fetch(u).then(r => r.json()).catch(() => null);
  const [a, g] = await Promise.all([leer('/datos/ayuda.json'), leer('/datos/aperturas-guia.json')]);
  AYUDA = (a?.temas || []).map(t => ({ ...t, _b: plano([t.t, (t.c || []).join(' '), t.r].join(' ')), _t: plano(t.t), _c: plano((t.c || []).join(' ')) }));
  GUIA = (g || []).map(o => ({ ...o, _t: plano(o.n), _c: plano([(o.a || []).join(' '), o.en, o.eco].join(' ')) }));
}

/* La tabla entera solo se toca si la guia no ha encontrado nada: son 3.810
   entradas y no hace falta recorrerlas para contestar «francesa». */
async function tablaLenta() {
  if (TABLA) return TABLA;
  const { tablaAperturas } = await import('./aperturas.js');
  const t = await tablaAperturas();
  const vistos = new Set();
  TABLA = [];
  for (const v of Object.values(t)) {
    if (vistos.has(v)) continue;
    vistos.add(v);
    const i = v.indexOf('|');
    const en = v.slice(i + 1);
    TABLA.push({ eco: v.slice(0, i), en, _t: plano(en) });
  }
  return TABLA;
}

/* ===========================================================================
   BUSCAR
   ===========================================================================
   Primero se exige que TODAS las palabras de la pregunta aparezcan en algun
   sitio. Si asi no sale nada, se relaja a «alguna»: mas vale una respuesta
   aproximada que un «no he encontrado nada» delante de alguien que solo ha
   escrito la palabra de mas.
   =========================================================================== */
function puntuar(o, palabras, todas) {
  let n = 0, tocadas = 0;
  for (const p of palabras) {
    let s = 0;
    if (hay(o._t, p)) s = 6;
    else if (o._c && hay(o._c, p)) s = 5;
    else if (o._b && hay(o._b, p)) s = 2;
    if (s) { tocadas++; n += s; }
  }
  if (todas && tocadas < palabras.length) return 0;
  return tocadas ? n + (o._t.startsWith(palabras[0]) ? 3 : 0) : 0;
}

function filtrar(lista, palabras) {
  // Segunda vuelta con minimo 5: al relajar a «alguna palabra» solo valen las
  // que han tocado el titulo o los sinonimos. Una coincidencia suelta en medio
  // de un parrafo no es una respuesta, es ruido.
  for (const [todas, minimo] of [[true, 1], [false, 5]]) {
    const r = lista.map(o => [puntuar(o, palabras, todas), o])
      .filter(([n]) => n >= minimo).sort((a, b) => b[0] - a[0]).map(([, o]) => o);
    if (r.length) return r;
  }
  return [];
}

async function buscar(q) {
  const palabras = palabrasDe(q);
  if (!palabras.length) return null;
  await datos();

  const temas = filtrar(AYUDA, palabras).slice(0, 6);
  let aperturas = filtrar(GUIA, palabras).slice(0, 6);

  // Solo se baja a la tabla grande si la guia no ha dicho nada y la palabra es
  // lo bastante larga como para no devolver doscientas coincidencias.
  if (!aperturas.length && palabras.some(p => p.length >= 4)) {
    aperturas = filtrar(await tablaLenta(), palabras).slice(0, 6);
  }
  return { temas, aperturas };
}

/* ===========================================================================
   ¿ESTA EN MI REPERTORIO?
   ===========================================================================
   Se recorre el arbol de cada curso marcado y cada linea propia buscando esa
   secuencia exacta de jugadas. Es una comprobacion de ORDEN, no de posicion:
   si tienes la Nimzoindia por otra transposicion, aqui saldra que no. Se dice
   claramente en la respuesta, porque una comprobacion que miente sin avisar es
   peor que no tenerla.
   =========================================================================== */
function recorre(arbol, sanes) {
  let n = 0;
  for (const s of sanes) {
    const h = (arbol.hijos[n] || []).find(x => arbol.san[x] === s);
    if (h === undefined) return false;
    n = h;
  }
  return true;
}

async function enMiRepertorio(sanes) {
  const { fuentesDelRepertorio } = await import('./comun.js');
  const { blancas, negras, faltan } = await fuentesDelRepertorio();
  const donde = [];
  for (const f of [...blancas, ...negras]) {
    if (f.arbol ? recorre(f.arbol, sanes)
                : String(f.jugadas || '').split(' ').filter(Boolean)
                    .slice(0, sanes.length).join(' ') === sanes.join(' ')) {
      donde.push(f.nombre);
    }
  }
  return { donde, faltan };
}

/* ===========================================================================
   PINTAR
   =========================================================================== */
function montar() {
  if (montado) return;
  montado = true;

  $('#asis-cerrar').addEventListener('click', cerrar);
  $('#asis-velo').addEventListener('click', cerrar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#asis').classList.contains('oculto')) cerrar();
  });

  let t = null;
  $('#asis-q').addEventListener('input', () => {
    if (charla.length) return;            // en mitad de una conversacion, no se pisa
    clearTimeout(t);
    t = setTimeout(pintarBusqueda, 90);   // el pulgar escribe a rafagas
  });
  $('#asis-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); enviar(); }
  });
  $('#asis-enviar').addEventListener('click', () => { clearTimeout(t); enviar(); });
  $('#asis-micro').classList.toggle('oculto', !puedeEscuchar());
  $('#asis-micro').addEventListener('click', () => { clearTimeout(t); micro(); });

  $('#asis-cuerpo').addEventListener('click', alPulsar);
}

function inicio() {
  volverA = null;
  charla = [];
  import('./chat.js').then(m => m.nuevaConversacion()).catch(() => {});
  $('#asis-q').value = '';
  $('#asis-cuerpo').innerHTML = `
    <p class="asis-intro">Pregúntame por un rival —su ficha FIDE, su nombre o su
      usuario de Lichess— y por lo que juega, o por cualquier cosa de la app.
      Envía con Intro, o toca el micro y pregúntamelo hablando.</p>
    <div class="asis-chips">
      ${['Juego de negras contra 1503014, ¿qué juega de blancas?',
         '¿Dónde me saca de mi repertorio?']
        .map(s => `<button class="asis-chip" data-chat-q="${escapar(s)}">${escapar(s)}</button>`).join('')}
      ${['¿Cómo subo un PGN?', 'El cruce en espejo', 'Defensa Francesa', 'Usar la app sin conexión']
        .map(s => `<button class="asis-chip" data-q="${escapar(s)}">${escapar(s)}</button>`).join('')}
    </div>`;
}

/* ===========================================================================
   LA CONVERSACION (Fase 35)
   =========================================================================== */
/* ===========================================================================
   PREGUNTAR HABLANDO (Fase 37)
   ===========================================================================
   Un toque empieza a escuchar y otro corta. Lo que se va entendiendo se
   escribe en el campo —asi se ve si ha oido bien— y al acabar se envia solo.
   La respuesta se lee en voz alta SOLO si la pregunta llego por voz: quien
   escribe esta mirando la pantalla y no quiere que el movil le hable. */
async function micro() {
  if (oyendo) { oyendo.abort(); return; }
  desbloquearAudio();                 // iOS: antes de cualquier await
  callar();
  const b = $('#asis-micro'), q = $('#asis-q');
  const ctrl = oyendo = new AbortController();
  b.classList.add('oyendo');
  b.setAttribute('aria-label', 'Dejar de escuchar');
  const antes = q.placeholder;
  q.value = '';
  q.placeholder = 'Te escucho…';
  let textos = [];
  try {
    ({ textos } = await escuchar({ alParcial: (t) => { q.value = t; }, senal: ctrl.signal, enviarAlCortar: true }));
  } catch (e) {
    q.placeholder = antes;
    q.value = '';
    const negado = /not-allowed|permission|denied/i.test(e.codigo || e.name || e.message);
    charla.push({ bot: negado
      ? 'No tengo permiso para usar el micrófono. Actívalo en los ajustes del navegador para esta web y vuelve a probar.'
      : `No he podido escucharte: ${escapar(e.message)}`, acciones: [] });
    pintarCharla();
    return;
  } finally {
    if (oyendo === ctrl) oyendo = null;
    b.classList.remove('oyendo');
    b.setAttribute('aria-label', 'Preguntar hablando');
    soltarMicro();
  }
  q.placeholder = antes;
  const texto = (textos[0] || '').trim();
  if (!texto) { q.value = ''; q.placeholder = 'No te he oído. Toca el micro y prueba otra vez.'; return; }
  enviar(texto, { porVoz: true });
}

/** El HTML de una respuesta, como texto para decirlo. Las filas de tabla y
 *  los saltos se convierten en pausas, y se corta en ~450 caracteres por
 *  frase entera: un parrafo leido entero no lo escucha nadie. */
function paraDecir(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html).replace(/<br\s*\/?>|<\/div>|<\/p>/gi, '. ');
  let t = d.textContent.replace(/\s*\.\s*(\.\s*)+/g, '. ').replace(/([?!:])\s*\./g, '$1')
    .replace(/\s+/g, ' ').trim();
  if (t.length > 450) {
    const corte = t.lastIndexOf('. ', 450);
    t = t.slice(0, corte > 120 ? corte + 1 : 450);
  }
  return textoAVoz(t);
}

async function enviar(texto = $('#asis-q').value.trim(), opciones = {}) {
  if (!texto) return;
  $('#asis-q').value = '';
  if (!opciones.rivalElegido) charla.push({ yo: texto });
  charla.push({ bot: '<span class="asis-nota">Pensando…</span>', acciones: [] });
  pintarCharla();
  let r;
  try {
    const { responder } = await import('./chat.js');
    r = await responder(texto, opciones);
    if (r.ayuda) r = { ...r, ...(await ayudaEnCharla(r.ayuda)) };
  } catch (e) {
    r = { html: `Algo ha fallado: ${escapar(e.message)}`, acciones: [] };
  }
  charla[charla.length - 1] = { bot: r.html + (r.pie ? `<br>${r.pie}` : ''), acciones: r.acciones || [] };
  pintarCharla();
  if (opciones.porVoz) hablar(paraDecir(r.html));
  if (r.ir) { cerrar(); irAPestana(r.ir); }
  if (r.abrir) abrirEnRival(r.abrir);
}

function pintarCharla() {
  const c = $('#asis-cuerpo');
  c.innerHTML = `<button class="asis-atras" data-nueva="1">← Nueva conversación</button>` +
    charla.map((m, i) => m.yo !== undefined
      ? `<div class="asis-msg yo">${escapar(m.yo)}</div>`
      : `<div class="asis-msg bot">${m.bot}${m.acciones.length ? `<div class="asis-acc">${
          m.acciones.map((a, k) => `<button class="btn btn-peq${k ? ' btn-sutil' : ''}" data-charla="${i}:${k}">${escapar(a.txt)}</button>`).join('')}</div>` : ''}</div>`
    ).join('');
  c.scrollTop = c.scrollHeight;
}

/* Las dudas de la app van al indice de siempre: el modelo no redacta ayuda. */
async function ayudaEnCharla(q) {
  const r = await buscar(q);
  if (!r || (!r.temas.length && !r.aperturas.length)) {
    return { html: `No tengo nada para «${escapar(q)}». Puedo contarte qué juega un rival
      («¿qué juega de blancas el 1503014?»), dónde se sale de tu repertorio, o
      ayudarte con las pestañas de la app.`, acciones: [] };
  }
  const acciones = [];
  const temas = r.temas.slice(0, 2).map(t => {
    for (const a of t.acc || []) acciones.push({ ...a, tipo: a.tipo === 'ir' ? 'ir' : a.tipo, tab: a.tab });
    return `<b>${escapar(t.t)}</b><br>${escapar(t.r)}`;
  });
  const aps = r.aperturas.slice(0, 3).map(a => {
    if (a.j) acciones.push({ txt: `${a.n || a.en} en el explorador`, tipo: 'explorador', linea: a.j });
    return `<b>${escapar(a.n || a.en)}</b> <span class="asis-nota">${escapar(a.eco)}${a.j ? ' · ' + escapar(a.j.join(' ')) : ''}</span>`;
  });
  const unicas = acciones.filter((a, k) => acciones.findIndex(b => b.txt === a.txt) === k);
  return { html: [...temas, ...aps].join('<br><br>'), acciones: unicas.slice(0, 4) };
}

async function abrirEnRival(a) {
  cerrar();
  irAPestana('rival');
  const { abrirRivalDesdeChat } = await import('./rival.js');
  abrirRivalDesdeChat(a);
}

async function pintarBusqueda() {
  const q = $('#asis-q').value.trim();
  if (!q) return inicio();

  const c = $('#asis-cuerpo');
  const r = await buscar(q);
  if (!r || (!r.temas.length && !r.aperturas.length)) return sinRespuesta(q);

  volverA = q;
  c.innerHTML =
    (r.temas.length ? `<h4 class="asis-rotulo">La app</h4>` + r.temas.map((t, i) => `
        <button class="asis-r" data-tema="${i}">
          <span class="asis-r-t">${escapar(t.t)}</span>
          <span class="asis-r-s">${escapar(t.r.slice(0, 90))}…</span>
        </button>`).join('') : '') +
    (r.aperturas.length ? `<h4 class="asis-rotulo">Aperturas</h4>` + r.aperturas.map((a, i) => `
        <button class="asis-r" data-ap="${i}">
          <span class="asis-r-t">${escapar(a.n || a.en)}</span>
          <span class="asis-r-s">${escapar(a.eco)}${a.n ? ' · ' + escapar(a.en) : ''}</span>
        </button>`).join('') : '');
  c._temas = r.temas;
  c._aperturas = r.aperturas;
  c.scrollTop = 0;
}

function verTema(t) {
  $('#asis-cuerpo').innerHTML = `
    ${atras()}
    <h4 class="asis-det-t">${escapar(t.t)}</h4>
    <p class="asis-det-r">${escapar(t.r)}</p>
    <div class="asis-acc">
      ${(t.acc || []).map((a, i) => `<button class="btn btn-peq" data-acc="${i}">${escapar(a.txt)}</button>`).join('')}
    </div>`;
  $('#asis-cuerpo')._acc = t.acc || [];
}

async function verApertura(a) {
  const c = $('#asis-cuerpo');
  const familia = await bloque(a.eco);
  const linea = a.j ? a.j.map((s, k) => (k % 2 ? '' : (k / 2 + 1) + '.') + s).join(' ') : '';

  c.innerHTML = `
    ${atras()}
    <h4 class="asis-det-t">${escapar(a.n || a.en)}</h4>
    <p class="asis-det-r">
      ${escapar(a.eco)} · ${escapar(familia)}${a.n ? `<br><span class="asis-en">En la app aparece como «${escapar(a.en)}»: los nombres vienen del conjunto de datos de Lichess, que está en inglés.</span>` : ''}
    </p>
    ${linea ? `<p class="asis-linea mono">${escapar(linea)}</p>` : ''}
    <div class="asis-acc">
      ${a.j ? `<button class="btn btn-peq" data-ap-exp="1">Verla en el explorador</button>` : ''}
      ${a.j ? `<button class="btn btn-peq btn-sutil" data-ap-rep="1">¿La tengo en mi repertorio?</button>` : ''}
      <button class="btn btn-peq btn-sutil" data-ap-fic="1">Buscarla en mis fichas</button>
    </div>
    <div id="asis-rep" class="asis-det-r"></div>`;
  c._ap = a;
}

const atras = () => `<button class="asis-atras" data-atras="1">← Volver</button>`;

async function bloque(eco) {
  try {
    const { bloqueDe } = await import('./bloques.js');
    return bloqueDe(eco)[1];
  } catch { return 'Sin clasificar'; }
}

/* ===========================================================================
   ACCIONES
   =========================================================================== */
async function alPulsar(e) {
  const c = $('#asis-cuerpo');
  const b = e.target.closest('button');
  if (!b) return;

  if (b.dataset.q)     { charla = []; $('#asis-q').value = b.dataset.q; return pintarBusqueda(); }
  if (b.dataset.chatQ) return enviar(b.dataset.chatQ);
  if (b.dataset.nueva) return inicio();
  if (b.dataset.charla) {
    const [i, k] = b.dataset.charla.split(':').map(Number);
    const a = charla[i]?.acciones?.[k];
    if (!a) return;
    if (a.tipo === 'rival') return abrirEnRival(a);
    if (a.tipo === 'elegir') return enviar(a.texto, { rivalElegido: a.rival });
    if (a.tipo === 'ir') { cerrar(); return irAPestana(a.tab); }
    if (a.tipo === 'enlace') { location.href = a.url; return; }
    if (a.tipo === 'explorador' || a.tipo === 'exp') {
      cerrar();
      const { abrirExplorador } = await import('./explorador.js');
      return abrirExplorador({ desde: a.linea || [], girado: !!a.girado });
    }
    return;
  }
  if (b.dataset.atras) { return volverA ? pintarBusqueda() : inicio(); }
  if (b.dataset.tema)  return verTema(c._temas[+b.dataset.tema]);
  if (b.dataset.ap)    return verApertura(c._aperturas[+b.dataset.ap]);

  if (b.dataset.acc) {
    const a = c._acc[+b.dataset.acc];
    if (a.tipo === 'ir')     { cerrar(); irAPestana(a.tab); }
    if (a.tipo === 'enlace') { location.href = a.url; }
    if (a.tipo === 'exp')    { cerrar(); (await import('./explorador.js')).abrirExplorador({}); }
    return;
  }

  const a = c._ap;
  if (b.dataset.apExp) {
    cerrar();
    const { abrirExplorador } = await import('./explorador.js');
    return abrirExplorador({ desde: a.j, titulo: a.n });
  }
  if (b.dataset.apFic) {
    // Se busca por el nombre INGLES: es el que llevan las fichas, porque sale
    // de la misma tabla de aperturas que las clasifica.
    cerrar();
    irAPestana('fichas');
    const i = $('#fc-buscar');
    if (i) { i.value = a.en; i.dispatchEvent(new Event('input', { bubbles: true })); }
    return;
  }
  if (b.dataset.apRep) {
    const caja = $('#asis-rep');
    caja.textContent = 'Mirando tus cursos…';
    try {
      const { donde, faltan } = await enMiRepertorio(a.j);
      caja.innerHTML = donde.length
        ? `Sí: la tienes en ${donde.map(n => `<b>${escapar(n)}</b>`).join(', ')}.`
        : `No la encuentro en tu repertorio. Ojo: compruebo <b>ese orden de jugadas</b>,
           así que si la tienes por otra transposición no la veo.` +
          (faltan ? ` Además hay ${faltan} curso(s) sin abrir todavía en este móvil,
           y de esos no puedo mirar el árbol.` : '');
    } catch {
      caja.textContent = 'No he podido leer tu repertorio ahora mismo.';
    }
  }
}

/* ===========================================================================
   EL HUECO DEL MODELO
   ===========================================================================
   Hoy esto es un callejon honrado. El dia que haya un /api/chat, la llamada va
   AQUI y en ningun otro sitio: todo lo anterior sigue contestando gratis y sin
   red, y el modelo solo se gasta en lo que el indice no cubre, que es
   exactamente para lo que valdria.
   =========================================================================== */
function sinRespuesta(q) {
  volverA = null;
  $('#asis-cuerpo').innerHTML = `
    <p class="asis-intro">No tengo nada para «${escapar(q)}».</p>
    <p class="asis-intro">Puedo ayudarte con las pestañas de la app, con lo que hace
      cada función y con nombres de apertura. Prueba con una palabra suelta:
      «rival», «fichas», «PGN», «siciliana».</p>`;
}

/* ===========================================================================
   ABRIR Y CERRAR
   =========================================================================== */
export function abrirAsistente({ irA } = {}) {
  if (irA) irAPestana = irA;
  montar();
  inicio();
  $('#asis').classList.remove('oculto');
  $('#burbuja').setAttribute('aria-expanded', 'true');
  // El foco al campo, pero sin abrir el teclado de golpe en movil: molesta mas
  // de lo que ayuda cuando lo que quieres es tocar una de las sugerencias.
  if (matchMedia('(min-width: 700px)').matches) $('#asis-q').focus();
  datos();
}

function cerrar() {
  oyendo?.abort();
  callar();
  $('#asis').classList.add('oculto');
  $('#burbuja').setAttribute('aria-expanded', 'false');
}
