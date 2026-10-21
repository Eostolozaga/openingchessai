/* ===========================================================================
   OpeningChessAI — pestaña Blind (Fase 38).

   El ajedrez a ciegas tiene su propia pestaña, con dos cosas que entrenar y
   dos formas de hacerlo:

     QUE                                   COMO
     · Fichas de tus partidas (Análisis)   · Easy: ves el tablero unas jugadas
     · Tus cursos (lo que era «A ciegas»     antes y luego se queda quieto
       en Entrenar, Fases 32 y 37)         · Hard: sin tablero, la posicion en
                                             coordenadas

   y en las dos, la voz de la Fase 37: la app te dice las jugadas y donde
   esta cada pieza, y tu contestas hablando.

   Los CURSOS siguen jugandose en entrenar.js (`entrenarCiegas`): aqui solo
   se eligen los ajustes. Las FICHAS DE TUS PARTIDAS se juegan aqui:

     1. Se reconstruye la partida hasta la ficha (`f.linea`) y se arranca
        `antes` medias jugadas antes del fallo.
     2. Easy: ves esa posicion; al pulsar «Que pasen» el tablero se congela y
        las jugadas de la partida van pasando escritas (y dichas).
        Hard: lo mismo, pero en vez de tablero la posicion va en coordenadas.
     3. Te toca: la jugada buena es la del motor —o cualquiera casi igual de
        buena, que a poca profundidad hay empates— y SOLO esa cuenta para la
        repeticion espaciada de la ficha.
     4. Si aciertas, Stockfish contesta en el movil y sigues TRES jugadas mas,
        todo de memoria. Es el «que siga el ejercicio varias jugadas»: no
        basta con ver la jugada, hay que llevar la posicion en la cabeza.
   =========================================================================== */

import { $, api, escapar } from './comun.js';
import { crearTablero } from './tablero.js';
import { desbloquearAudio, hablar, sanAVoz, lineaAVoz, vozAJugada, vozAOrden, describirPosicion } from './voz.js';
import { crearManosLibres, hayVoz } from './manoslibres.js';

const SEGUIR = 3;                     // jugadas tuyas despues de la ficha
const PROF = 12;                      // la profundidad del resto de la app
const VACIO = '8/8/8/8/8/8/8/8 w - - 0 1';
const FASES = { apertura: 'Apertura', medio: 'Medio juego', final: 'Final' };
const NOMBRE = { p: 'un peón', n: 'el caballo', b: 'el alfil', r: 'la torre', q: 'la dama', k: 'el rey' };

let montado = false;
let Chess = null;
let fichas = null;                    // las de Análisis, tal cual las da el servidor
let tablero = null;
let ml = null;
let s = null;                         // la sesion de fichas en curso

const color = (c) => c === 'white' ? 'blancas' : 'negras';
const epd = (fen) => String(fen).split(' ').slice(0, 4).join(' ');
const tocaYa = (f) => new Date(f.proxima).getTime() <= Date.now();

/* ===========================================================================
   LA PESTAÑA
   =========================================================================== */
let lanzarCursos = null;              // lo pone app.js: entrenar.js preparado

export async function mostrarBlind({ ciegas } = {}) {
  if (ciegas) lanzarCursos = ciegas;
  if (!montado) montar();
  const conVoz = hayVoz();
  $('#bl-voz-fila').classList.toggle('oculto', !conVoz);
  pintarExplicacion();

  // Los cursos: los mismos que Entrenar.
  const { fuentesDeCursos, prepararCursos } = await import('./mapacursos.js');
  await prepararCursos().catch(() => {});
  const cursos = await fuentesDeCursos().catch(() => []);
  const elegido = $('#bl-curso').value;
  $('#bl-curso').innerHTML = '<option value="">Todos mis cursos</option>' +
    cursos.map(c => `<option value="${escapar(c.id)}">${escapar(c.nombre)}</option>`).join('');
  $('#bl-curso').value = cursos.some(c => c.id === elegido) ? elegido : '';
  $('#btn-bl-cursos').disabled = !cursos.length;
  $('#bl-cursos-nota').textContent = cursos.length ? '' : 'Sube un curso en Cursos para poder entrenarlo a ciegas.';

  // Las fichas de tus partidas.
  try {
    fichas = (await api('analisis/fichas')).fichas || [];
  } catch (e) {
    fichas = fichas || [];
    $('#bl-fichas-nota').textContent = `No he podido traer tus fichas: ${e.message}`;
  }
  pintarFichas();
}

function montar() {
  montado = true;
  $('#bl-dif').addEventListener('change', pintarExplicacion);
  $('#btn-bl-fichas').addEventListener('click', () => {
    const voz = $('#bl-con-voz').checked && hayVoz();
    if (voz) desbloquearAudio();        // iOS: dentro del toque y antes de await
    empezarFichas({ voz });
  });
  $('#btn-bl-cursos').addEventListener('click', async () => {
    const voz = $('#bl-con-voz').checked && hayVoz();
    if (voz) desbloquearAudio();
    lanzarCursos?.({
      cursoId: $('#bl-curso').value, color: $('#bl-color').value, orden: $('#bl-orden').value,
      desde: +$('#bl-desde').value, dificultad: $('#bl-dif').value, voz,
    });
  });
}

function pintarExplicacion() {
  const hard = $('#bl-dif').value === 'hard';
  $('#bl-dif-nota').innerHTML = hard
    ? '<b>Hard</b>: no hay tablero. La posición se escribe en coordenadas (y se dice, con voz) y a partir de ahí todo va de memoria.'
    : '<b>Easy</b>: ves el tablero unas jugadas antes; luego se queda quieto y las jugadas siguientes pasan escritas.';
}

function pintarFichas() {
  const l = fichas || [];
  const toca = l.filter(tocaYa).length;
  const porFase = (k) => l.filter(f => f.fase === k).length;
  const sel = $('#bl-cuales'), antes = sel.value || 'toca';
  sel.innerHTML = [
    ['toca', `Las que tocan hoy (${toca})`],
    ['todas', `Todas (${l.length})`],
    ...Object.entries(FASES).map(([k, t]) => [k, `${t} (${porFase(k)})`]),
  ].map(([v, t]) => `<option value="${v}">${escapar(t)}</option>`).join('');
  sel.value = antes;
  $('#btn-bl-fichas').disabled = !l.length;
  if (!l.length) {
    $('#bl-fichas-nota').innerHTML = 'Aún no tienes fichas de tus partidas. Pásalas por el motor en ' +
      '<b>Análisis → Errores</b> y pulsa «Crear fichas».';
  } else if (!$('#bl-fichas-nota').textContent.startsWith('No he podido')) {
    $('#bl-fichas-nota').textContent = `${l.length} fichas de fallos de tus partidas · ${toca} tocan hoy.`;
  }
}

/* ===========================================================================
   LA SESION DE FICHAS
   =========================================================================== */
async function empezarFichas({ voz }) {
  const l = fichas || [];
  const que = $('#bl-cuales').value;
  let cola = que === 'toca' ? l.filter(tocaYa) : que === 'todas' ? [...l] : l.filter(f => f.fase === que);
  if (!cola.length) cola = [...l];      // «hoy no toca ninguna» no es motivo para no entrenar
  if (!cola.length) return;
  // Barajadas: en orden fijo se memoriza la secuencia, no la posicion.
  cola = cola.map(f => [Math.random(), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]).slice(0, 20);

  if (!Chess) ({ Chess } = await import('./vendor/chess.js'));
  if (!tablero) {
    tablero = crearTablero($('#bl-tablero'), { Chess, alJugar, alIlegal });
    $('#bl-cerrar').addEventListener('click', cerrar);
    $('#bl-girar').addEventListener('click', () => tablero.setGirado(!tablero.estaGirado()));
    $('#bl-siguiente').addEventListener('click', boton);
    $('#bl-pista').addEventListener('click', () => pista());
    $('#bl-ver').addEventListener('click', ver);
    $('#bl-voz').addEventListener('click', () => { desbloquearAudio(); alternarVoz(); });
    ml = crearManosLibres({ p: 'bl', alOir: oir, alVolver: dondeEstamos,
                            alAviso: (t) => decir(escapar(t), 'mal') });
  }
  s = {
    cola, i: 0, bien: 0, dif: $('#bl-dif').value, antes: +$('#bl-antes').value,
    f: null, ch: null, inicio: null, pasadas: [], desde: 0, despues: [],
    fase: 'nada', paso: 0, pista: false, mejor: null, evalAntes: null, relojes: [],
  };
  $('#bl').classList.remove('oculto');
  document.body.classList.add('sin-scroll');
  $('#bl-voz').classList.toggle('oculto', !hayVoz());
  if (voz) ml.encender();
  ml.pintar();
  mostrarFicha();
}

function cerrar() {
  limpiar();
  if (ml?.activa) ml.apagar();
  $('#bl').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
  s = null;
  mostrarBlind();                       // los contadores de «tocan hoy» han cambiado
}

function limpiar() { for (const t of s?.relojes || []) clearTimeout(t); if (s) s.relojes = []; }
function reloj(fn, ms) { const yo = s; s.relojes.push(setTimeout(() => { if (s === yo) fn(); }, ms)); }

function decir(html, clase = '') {
  const e = $('#bl-mensaje');
  e.className = 'ent-mensaje ' + clase;
  e.innerHTML = html;
}
const vozOn = () => !!(ml?.activa && s);

function marcador() {
  $('#bl-marcador').textContent = `${Math.min(s.i + 1, s.cola.length)}/${s.cola.length} · ${s.bien} bien`;
}

/** Las jugadas que se han ido diciendo desde que se congelo, numeradas. */
function pintarLinea() {
  const todas = [...s.pasadas, ...s.despues];
  $('#bl-linea').innerHTML = todas.length
    ? `<span class="ciega-corte">◼</span> <b>${escapar(numerar(todas, s.desde).join(' '))}</b>` : '';
}
function numerar(sanes, desde) {
  return sanes.map((x, k) => {
    const i = desde + k;
    if (i % 2 === 0) return `${i / 2 + 1}. ${x}`;
    return k === 0 ? `${(i - 1) / 2 + 1}… ${x}` : x;
  });
}

function pintarCoords(fen) {
  const c = $('#bl-coords');
  c.classList.toggle('oculto', !fen);
  c.textContent = fen ? describirPosicion(fen, s.f.color === 'black' ? 'b' : 'w').texto : '';
}

function botones({ siguiente = null, pista = false } = {}) {
  $('#bl-siguiente').classList.toggle('oculto', !siguiente);
  if (siguiente) $('#bl-siguiente').textContent = siguiente;
  $('#bl-pista').classList.toggle('oculto', !pista);
  $('#bl-ver').classList.toggle('oculto', !pista);
}

/* --- 1. La ficha y la posicion de salida -------------------------------- */
function mostrarFicha() {
  limpiar();
  tablero.limpiarPista();
  const f = s.f = s.cola[s.i];
  if (!f) return finSesion();
  marcador();
  $('#bl-titulo').textContent = f.apertura || FASES[f.fase] || 'Ficha';

  // La partida hasta la ficha. Si no casa con el FEN guardado (fichas viejas
  // sin linea), se arranca en la posicion misma.
  const sanes = String(f.linea || '').split(' ').filter(Boolean);
  const ch = new Chess();
  let ok = true;
  for (const x of sanes) { try { ch.move(x); } catch { ok = false; break; } }
  if (!ok || epd(ch.fen()) !== epd(f.fen)) sanes.length = 0;
  const k = sanes.length ? Math.min(s.antes, sanes.length) : 0;
  const ini = new Chess();
  for (const x of sanes.slice(0, sanes.length - k)) ini.move(x);
  s.inicio = sanes.length ? ini.fen() : f.fen;
  s.pasadas = sanes.slice(sanes.length - k);
  s.desde = sanes.length - k;
  s.despues = [];
  s.ch = new Chess(s.inicio);
  s.paso = 0; s.pista = false; s.mejor = f.mejor; s.evalAntes = null;

  tablero.setGirado(f.color === 'black');
  tablero.mostrar(s.inicio);
  $('#bl-linea').innerHTML = '';
  const duro = s.dif === 'hard';
  if (duro) { tablero.setVista(VACIO); $('#bl-tablero').classList.add('ciega'); pintarCoords(s.inicio); }
  else { tablero.setVista(null); $('#bl-tablero').classList.remove('ciega'); pintarCoords(null); }

  if (!k) {
    // Sin jugadas que pasen: la posicion, y a contestar. En Easy se tapa al
    // empezar a pensar, que es lo que la hace «a ciegas».
    if (!duro) congelar();
    return preguntar();
  }
  s.fase = 'mirar';
  const quien = `Juegan ${color(new Chess(s.inicio).turn() === 'w' ? 'white' : 'black')}`;
  decir(duro
    ? `Esta es la posición ${k} medias jugadas antes de tu fallo. ${quien}. <span class="apunte">Cuando la tengas, que pasen las jugadas.</span>`
    : `Memoriza el tablero: ${k} medias jugadas antes de tu fallo. <span class="apunte">Al seguir se queda quieto y las jugadas pasan escritas.</span>`);
  botones({ siguiente: 'Que pasen las jugadas' });
  if (vozOn()) {
    ml.decir(duro
      ? `Ficha ${s.i + 1}. ${describirPosicion(s.inicio, f.color === 'black' ? 'b' : 'w').voz} Di «sigue» y pasan las jugadas.`
      : `Ficha ${s.i + 1}. Memoriza el tablero. Di «sigue» cuando lo tengas.`);
  }
}

function congelar() {
  tablero.setVista(s.dif === 'hard' ? VACIO : s.inicio);
  $('#bl-tablero').classList.add('ciega');
}

/* --- 2. Pasan las jugadas ------------------------------------------------ */
function pasar() {
  s.fase = 'pasando';
  botones();
  congelar();
  if (vozOn()) {
    // Con voz se dicen todas seguidas y se pregunta al acabar.
    for (const x of s.pasadas) s.ch.move(x);
    pintarLinea();
    decir('Pasan las jugadas…');
    return preguntar(`Pasan: ${lineaAVoz(s.pasadas, s.desde)} `);
  }
  // Sin voz, una a una: verlas aparecer es lo que obliga a moverlas en la cabeza.
  const todas = s.pasadas;
  s.pasadas = [];
  decir('Atento: van pasando las jugadas…');
  todas.forEach((x, k) => reloj(() => {
    s.ch.move(x);
    s.pasadas.push(x);
    pintarLinea();
    if (k === todas.length - 1) reloj(() => preguntar(), 700);
  }, 900 + k * 1400));
}

/* --- 3. Te toca ---------------------------------------------------------- */
function preguntar(prefijoVoz = '') {
  s.fase = 'pregunta';
  // La posicion real para el tablero (las jugadas se tocan contra ella) con
  // la vista congelada encima.
  tablero.mostrar(s.ch.fen());
  if (s.dif === 'hard' || s.pasadas.length || s.paso) congelar();
  const f = s.f;
  if (s.paso === 0) {
    decir(`Juegan <b>${color(f.color)}</b>. En la partida jugaste <b class="mono">${escapar(f.jugada)}</b>. ¿Cuál era la buena?`);
  } else {
    decir(`Responde <b class="mono">${escapar(s.despues.at(-1))}</b>. <span class="apunte">Jugada ${s.paso} de ${SEGUIR} más: ¿y ahora?</span>`);
  }
  botones({ pista: true });
  if (vozOn()) {
    ml.decir(prefijoVoz + (s.paso === 0
      ? `Juegan ${color(f.color)}. En la partida jugaste ${sanAVoz(f.jugada)}. ¿Cuál era la buena?`
      : `Responde ${sanAVoz(s.despues.at(-1))}. ¿Y ahora?`), { encolar: true });
  }
}

function pista(porVoz = false) {
  if (s?.fase !== 'pregunta' || !s.mejor) return;
  s.pista = true;
  const m = s.ch.moves({ verbose: true }).find(x => x.san === s.mejor);
  if (!m) return;
  const enroque = /^O-O/.test(m.san);
  decir(enroque ? '💡 Pista: <b>enroque</b>.'
    : `💡 Pista: mueve <b>${NOMBRE[m.piece]}</b> de <b>${m.from}</b>. <span class="apunte">Con pista no cuenta como acierto.</span>`, 'pista');
  if (vozOn() || porVoz) {
    ml.decir(enroque ? 'Pista: enroque.' : `Pista: mueve ${NOMBRE[m.piece]} de ${sanAVoz(m.from)}. Ya no cuenta como acierto.`);
  }
}

/** Tres segundos con la posicion de verdad. Cuenta como la pista. */
function ver() {
  if (s?.fase !== 'pregunta') return;
  s.pista = true;
  tablero.setVista(null);
  $('#bl-tablero').classList.remove('ciega');
  pintarCoords(null);
  const yo = s;
  setTimeout(() => {
    if (s !== yo || s.fase !== 'pregunta') return;
    congelar();
    if (s.dif === 'hard') pintarCoords(s.inicio);
  }, 3000);
  decir('👁 Así está ahora. <span class="apunte">Mirar cuenta como pista.</span>', 'pista');
}

function alIlegal() {
  if (s?.fase !== 'pregunta') return;
  decir('Esa jugada no es legal en la posición real. <span class="apunte">No cuenta como fallo: prueba otra.</span>');
  if (vozOn()) ml.decir('Esa jugada no es legal. Prueba otra.');
}

/* --- 4. Juzgar: la del motor o una casi igual de buena -------------------- */
async function alJugar(hecha) {
  if (s?.fase !== 'pregunta') { tablero.mostrar(s ? s.ch.fen() : hecha.after); return; }
  ml?.cortar();
  s.fase = 'juzgando';
  botones();
  const antes = s.ch.fen();
  let vale = hecha.san === s.mejor;
  if (!vale) {
    decir('Comprobando esa jugada con el motor…');
    try {
      const { evaluar } = await import('./motor.js');
      const { aCp, ganar } = await import('./juicio.js');
      const signo = s.ch.turn() === 'w' ? 1 : -1;
      const ea = s.evalAntes || await evaluar(antes, PROF);
      const ed = await evaluar(hecha.after, PROF);
      vale = ganar(signo * aCp(ea)) - ganar(signo * aCp(ed)) < 0.05;
    } catch { /* sin motor, solo vale la del motor */ }
  }
  if (!s) return;
  if (s.paso === 0) apuntarFicha(vale && !s.pista);
  if (!vale) return fallo(hecha.san);

  s.ch.move(hecha.san);
  s.despues.push(hecha.san);
  pintarLinea();
  if (s.paso === 0 && !s.pista) s.bien++;
  marcador();
  const otra = hecha.san !== s.mejor ? ` <span class="apunte">(la del motor era ${escapar(s.mejor)})</span>` : '';
  if (s.paso >= SEGUIR) return completa(otra);
  decir(`Bien: <b class="mono">${escapar(hecha.san)}</b>.${otra} <span class="apunte">Piensa el motor…</span>`, 'bien');
  responderMotor(hecha.san !== s.mejor ? `Vale ${sanAVoz(hecha.san)}. ` : 'Bien. ');
}

/** Stockfish contesta por el rival y calcula ya tu siguiente buena. */
async function responderMotor(prefijoVoz) {
  const yo = s;
  try {
    const { evaluar } = await import('./motor.js');
    const r = await evaluar(s.ch.fen(), PROF);
    if (s !== yo) return;
    if (!r.mejor) return completa(' <span class="apunte">La partida se ha acabado.</span>');
    const j = s.ch.move({ from: r.mejor.slice(0, 2), to: r.mejor.slice(2, 4), promotion: r.mejor[4] || undefined });
    s.despues.push(j.san);
    pintarLinea();
    const sig = await evaluar(s.ch.fen(), PROF);
    if (s !== yo) return;
    if (!sig.mejor) return completa(` <span class="apunte">${escapar(j.san)} y se acaba la partida.</span>`);
    const m = new Chess(s.ch.fen()).move({ from: sig.mejor.slice(0, 2), to: sig.mejor.slice(2, 4), promotion: sig.mejor[4] || undefined });
    s.mejor = m.san;
    s.evalAntes = sig;
    s.paso++;
    s.pista = false;
    preguntar(prefijoVoz);
  } catch (e) {
    if (s !== yo) return;
    completa(` <span class="apunte">El motor no ha podido seguir (${escapar(e.message)}).</span>`);
  }
}

/** Se destapa el tablero: comparar la posicion que tenias con la de verdad. */
function destapar(marcar = null) {
  tablero.setVista(null);
  $('#bl-tablero').classList.remove('ciega');
  pintarCoords(null);
  tablero.mostrar(s.ch.fen(), marcar);
}

function fallo(hecha) {
  const buena = s.mejor;
  destapar();
  const cas = tablero.casillasDe(buena);
  if (cas) tablero.marcarPista(cas.from, cas.to);
  s.fase = 'fin';
  decir(s.paso === 0
    ? `<b class="mono">${escapar(hecha)}</b> no. La buena era <b class="mono">${escapar(buena)}</b>. <span class="apunte">Vuelve pronto a la cola.</span>`
    : `<b class="mono">${escapar(hecha)}</b> no: el motor jugaba <b class="mono">${escapar(buena)}</b>. <span class="apunte">Llegaste a ${s.paso - 1} de ${SEGUIR} jugadas más. Así está de verdad.</span>`,
    'mal');
  botones({ siguiente: s.i + 1 < s.cola.length ? 'Siguiente ficha' : 'Terminar' });
  if (vozOn()) {
    ml.decir(`No. ${s.paso === 0 ? 'La buena era' : 'El motor jugaba'} ${sanAVoz(buena)}. ` +
      'Di «siguiente» para otra ficha, «línea» para oír las jugadas, o «para».');
  }
}

function completa(extra = '') {
  destapar();
  s.fase = 'fin';
  decir(`¡Completa! La ficha y ${SEGUIR} jugadas más de memoria.${extra} <span class="apunte">Compara con la que tenías en la cabeza.</span>`, 'bien');
  botones({ siguiente: s.i + 1 < s.cola.length ? 'Siguiente ficha' : 'Terminar' });
  if (vozOn()) ml.decir(`Completa. Bien hecho. Di «siguiente» para otra ficha, o «para».`);
}

function finSesion() {
  s.fase = 'terminada';
  marcador();
  destaparSiHay();
  decir(`Sesión terminada: <b>${s.bien} de ${s.cola.length}</b> fichas a la primera y sin pista.`, 'bien');
  botones({ siguiente: 'Cerrar' });
  if (vozOn()) ml.decir(`Sesión terminada: ${s.bien} de ${s.cola.length}. Di «para» o «siguiente» para cerrar.`);
}
function destaparSiHay() { if (s.ch) destapar(); }

function boton() {
  if (!s) return;
  if (s.fase === 'mirar') return pasar();
  if (s.fase === 'fin') { s.i++; return mostrarFicha(); }
  if (s.fase === 'terminada') return cerrar();
}

/** La repeticion espaciada de la ficha: solo cuenta la primera jugada. */
async function apuntarFicha(bien) {
  const f = s.f;
  try {
    const r = await api('analisis/fichas/repaso', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: f.id, bien }),
    });
    const x = (fichas || []).find(y => y.id === f.id);
    if (x) { x.proxima = r.proxima; x.intervalo = r.intervalo; if (bien) x.reps++; else x.fallos++; }
  } catch { /* sin red: la ficha sigue tocando, que es lo seguro */ }
}

/* ===========================================================================
   LA VOZ
   =========================================================================== */
function alternarVoz() {
  if (!s) return;
  if (ml.activa) { ml.apagar(); hablar('Voz apagada.'); return; }
  ml.encender();
  dondeEstamos();
}

function dondeEstamos() {
  if (!vozOn()) return;
  if (s.fase === 'mirar') return ml.decir('Di «sigue» y pasan las jugadas.');
  if (s.fase === 'pregunta') {
    return ml.decir(s.paso === 0 ? `Juegan ${color(s.f.color)}. ¿Cuál era la buena?` : `Responde ${sanAVoz(s.despues.at(-1))}. ¿Y ahora?`);
  }
  if (s.fase === 'fin' || s.fase === 'terminada') ml.decir('Di «siguiente» o «para».');
}

function oir(textos) {
  if (!vozOn()) return;
  if (s.fase === 'pregunta') {
    const j = vozAJugada(textos, s.ch);
    if (j?.jugada) return alJugar(j.jugada);
    const o = vozAOrden(textos);
    if (o) return orden(o);
    if (j?.ambiguas) return ml.decir(`¿Cuál? ${j.ambiguas.slice(0, 3).map(sanAVoz).join(', o ')}.`);
    if (j?.ilegal) return ml.decir('Esa jugada no se puede hacer aquí. Repite la jugada.');
    return ml.decir('No te he entendido. Di la jugada, por ejemplo: caballo efe tres.');
  }
  const o = vozAOrden(textos);
  if (o) return orden(o);
  if (s.fase === 'mirar') return ml.decir('Di «sigue» cuando la tengas.');
  ml.decir('Di «siguiente» o «para».');
}

function orden(o) {
  if (o === 'parar') { ml.apagar(); hablar('Voz apagada.'); return; }
  if (o === 'siguiente') {
    if (s.fase === 'mirar' || s.fase === 'fin' || s.fase === 'terminada') return boton();
    return ml.escuchar();
  }
  if (o === 'pista') return s.fase === 'pregunta' ? pista(true) : ml.escuchar();
  if (o === 'piezas') {
    return ml.decir(describirPosicion(s.inicio, s.f.color === 'black' ? 'b' : 'w').voz +
      (s.pasadas.length || s.despues.length ? ` Después: ${lineaAVoz([...s.pasadas, ...s.despues], s.desde)}` : ''));
  }
  if (o === 'linea' || o === 'repite') {
    const todas = [...s.pasadas, ...s.despues];
    if (o === 'repite' && s.despues.length) return ml.decir(`Última: ${sanAVoz(todas.at(-1))}. ¿Y ahora?`);
    return ml.decir(todas.length ? lineaAVoz(todas, s.desde) : 'Aún no ha pasado ninguna jugada.');
  }
  ml.escuchar();
}
