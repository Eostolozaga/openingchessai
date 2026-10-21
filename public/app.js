/* ===========================================================================
   OpeningChessAI — esqueleto de la app.

   Vanilla y sin build. Para cinco pestanas, cualquier framework pesaria mas
   que la app entera y anadiria un paso de compilacion entre "escribo" y
   "esta desplegado".

   Todo lo que se pinta sale de la API real. No hay datos de ejemplo: una
   lista vacia honesta ensena mas que una llena de mentira.
   =========================================================================== */

import { $, $$, api, aviso, limpiarAviso, conBoton, tamano, escapar } from './comun.js';
import { borrarArbol } from './almacen.js';

let usuario = null;
let visor = null;          // se importa la primera vez que se abre un curso

/* ===========================================================================
   QUE FALLA (Fase 33)
   ===========================================================================
   Los errores de JavaScript que nadie captura se apuntan en el servidor —solo
   el mensaje y el fichero:linea, sin usuario— para verlos en la pantalla de
   accesos. Sin esto, un fallo en el movil de otro solo se conoce si te lo
   cuentan, y casi nunca te lo cuentan.

   Tope de cinco por carga y sin repetir: un fallo en un bucle no puede
   convertirse en mil escrituras. Los de red no se apuntan: «sin conexion» no
   es un fallo de la app, y sin conexion tampoco llegaria. */
const erroresVistos = new Set();
function apuntarError(mensaje, donde) {
  const m = String(mensaje || '').slice(0, 160);
  if (!m || erroresVistos.size >= 5) return;
  if (/failed to fetch|networkerror|load failed|sin conexi|resizeobserver|sin sesion/i.test(m)) return;
  const k = m + '|' + donde;
  if (erroresVistos.has(k)) return;
  erroresVistos.add(k);
  try {
    fetch('/api/errores', { method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ m, f: String(donde || '?').slice(0, 80) }) }).catch(() => {});
  } catch { /* nada: apuntar un error no puede provocar otro */ }
}
const sitio = (fichero, linea) => `${String(fichero || '?').split('/').pop().split('?')[0]}:${linea || 0}`;
window.addEventListener('error', (e) => apuntarError(e.message, sitio(e.filename, e.lineno)));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const linea = String(r?.stack || '').split('\n').find(l => /\.js:\d+/.test(l)) || '';
  const m = linea.match(/([\w.-]+\.js):(\d+)/);
  apuntarError(r?.message || String(r), m ? `${m[1]}:${m[2]}` : '?');
});

/* ===========================================================================
   ARRANQUE
   =========================================================================== */
window.addEventListener('openingchessai:sin-sesion', () => { usuario = null; mostrarAcceso(); });

/* Si el administrador retira el acceso con la app abierta, la siguiente
   peticion contesta 403. Se cambia de pantalla en el sitio, sin recargar: se ve
   raro que una app se quede a medias sin decir por que. */
window.addEventListener('openingchessai:sin-aprobar', (e) => {
  if (!usuario) return;
  usuario.estado = e.detail?.estado || 'pendiente';
  mostrarEspera();
});

(async () => {
  try {
    const { user } = await api('session');
    if (!user) return mostrarAcceso();
    usuario = user;
    // La puerta se comprueba aqui y no esperando al primer 403: asi no se pinta
    // la app un instante antes de esconderla.
    if (!user.admin && user.estado !== 'activo') return mostrarEspera();
    mostrarApp();
  } catch {
    // Sin red y sin copia guardada no se puede saber quien eres: se ensena el
    // acceso, que es lo unico util que se puede ofrecer en ese estado. Si SI
    // hay copia, `api` la devuelve y no se llega hasta aqui.
    mostrarAcceso();
  }
})();

/* ===========================================================================
   SIN CONEXION
   ===========================================================================
   El aviso se pinta a partir de `navigator.onLine`, que miente en un sentido
   util: dice `false` solo cuando el sistema esta seguro de que no hay red, y
   `true` con una wifi de hotel que no lleva a ninguna parte. Por eso no se usa
   para DECIDIR nada —eso lo decide que la peticion falle— sino solo para
   avisar. La sala de un torneo con la cobertura saturada cae en el segundo
   caso: la app funcionara igual con las copias guardadas, simplemente sin este
   cartel. */
function pintarRed() {
  $('#sin-red')?.classList.toggle('oculto', navigator.onLine !== false);
}
window.addEventListener('online', pintarRed);
window.addEventListener('offline', pintarRed);
pintarRed();

/* La barra de instalar. Se engancha ANTES de saber si hay sesion porque el
   evento del navegador llega cuando quiere —a veces en el primer segundo— y si
   nadie lo esta escuchando en ese momento, se pierde y no vuelve hasta la
   siguiente visita. */
import('./instalar.js').then(m => m.prepararInstalar()).catch(() => {});

/** Todas las pantallas superpuestas fuera. Se llama al cambiar de estado
 *  general: si a alguien se le retira el acceso con el visor abierto, el visor
 *  no puede quedarse encima de la sala de espera. */
function cerrarTodo() {
  for (const id of ['#visor', '#pos', '#ent', '#libro', '#exp', '#editor', '#admin', '#an-repaso']) {
    $(id)?.classList.add('oculto');
  }
  document.body.classList.remove('sin-scroll');
}

function mostrarAcceso() {
  $('#cargando').classList.add('oculto');
  $('#app').classList.add('oculto');
  $('#espera').classList.add('oculto');
  cerrarTodo();
  $('#acceso').classList.remove('oculto');
}

function mostrarApp() {
  $('#cargando').classList.add('oculto');
  $('#acceso').classList.add('oculto');
  $('#espera').classList.add('oculto');
  $('#app').classList.remove('oculto');

  $('#quien').textContent =
    usuario.nombre || usuario.lichess || (usuario.email || '').split('@')[0] || 'jugador';
  $('#cede').checked = !!usuario.cede;

  if (usuario.admin) prepararJefe();
  pintarFide();
  pintarChesscom();
  cargarInicio();
  atajoDelManifiesto();
}

/* Los accesos directos del icono instalado —«Preparar un rival», «Entrenar»—
   llegan como `?ir=…`. Se aplican DESPUES de comprobar la sesion, porque saltar
   a Entrenar sin saber quien eres no lleva a ninguna parte, y se limpia el
   parametro de la barra para que recargar no vuelva a saltar. */
function atajoDelManifiesto() {
  const mapa = { rival: 'rival', entrenar: 'train', fichas: 'fichas',
                 rep: 'rep', cursos: 'cursos', analisis: 'analisis', blind: 'blind' };
  const tab = mapa[new URLSearchParams(location.search).get('ir')];
  if (!tab) return;
  irA(tab);
  history.replaceState(null, '', location.pathname);
}

/* ===========================================================================
   SALA DE ESPERA
   ===========================================================================
   Dos textos distintos, porque son dos situaciones distintas y confundirlas es
   cruel en un sentido y engañoso en el otro. A quien espera se le dice que
   espere; a quien se le ha retirado el acceso se le dice eso mismo, sin
   adornos y sin "vuelve a intentarlo", que solo alarga el paseo.
   =========================================================================== */
function mostrarEspera() {
  $('#cargando').classList.add('oculto');
  $('#acceso').classList.add('oculto');
  $('#app').classList.add('oculto');
  cerrarTodo();
  $('#espera').classList.remove('oculto');

  const bloqueado = usuario.estado === 'bloqueado';
  $('#espera-sub').textContent = bloqueado
    ? 'Tu acceso ha sido retirado' : 'Tu cuenta está pendiente de aprobación';
  $('#espera-titulo').textContent = bloqueado ? 'Sin acceso' : 'Ya casi';
  $('#espera-cuerpo').innerHTML = bloqueado
    ? `<p style="margin:0;font-size:14px;line-height:1.7">
         Esta app es cerrada y el acceso a tu cuenta se ha retirado. Tus cursos
         y tus partidas siguen guardados y no se han borrado.</p>
       <p style="margin:10px 0 0;font-size:14px;line-height:1.7;color:var(--muted)">
         Si crees que es un error, escribe a quien te dio el acceso.</p>`
    : `<p style="margin:0;font-size:14px;line-height:1.7">
         Esta app es cerrada: entra solo la gente a la que se le da acceso a
         mano. Tu cuenta ya está creada y a la espera de que la aprueben.</p>
       <p style="margin:10px 0 0;font-size:14px;line-height:1.7;color:var(--muted)">
         No hay que hacer nada más. Cuando esté aprobada, entrarás con este
         mismo correo o con este mismo usuario de Lichess.</p>`;

  $('#espera-pie').textContent = bloqueado
    ? 'Nada de lo que subiste se ha borrado.'
    : 'Nada de lo que hayas subido se borra mientras esperas.';

  // Enseñar con QUE cuenta ha entrado: la mitad de los "no me deja entrar" son
  // en realidad "he entrado con la otra cuenta".
  $('#espera-quien').innerHTML = [
    usuario.lichess ? `Lichess: <b>${escapar(usuario.lichess)}</b>` : null,
    usuario.email ? `Correo: <b>${escapar(usuario.email)}</b>` : null,
    usuario.fide_id ? `FIDE: <b>${escapar(usuario.fide_id)}</b>` : null,
  ].filter(Boolean).join('<br>') || 'Sin datos de contacto.';
}

$('#espera-salir').addEventListener('click', () => { location.href = '/api/auth/logout'; });
$('#espera-recargar').addEventListener('click', () => location.reload());

/* ===========================================================================
   ACCESO
   =========================================================================== */
$('#form-correo').addEventListener('submit', async (e) => {
  e.preventDefault();
  limpiarAviso('#aviso-acceso');
  const email = $('#correo').value.trim();
  const fide  = $('#fide').value.trim();
  try {
    await conBoton('#btn-correo', 'Enviando…', () =>
      api('auth/magic', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, fide_id: fide || undefined }),
      }));
    aviso('#aviso-acceso',
      `Enlace enviado a ${email}. Caduca en 15 minutos y sirve una sola vez.`, 'bien');
    $('#form-correo').reset();
  } catch (err) { aviso('#aviso-acceso', err.message); }
});

$('#btn-salir').addEventListener('click', () => { location.href = '/api/auth/logout'; });
$('#btn-tema').addEventListener('click', alternarTema);

/* ===========================================================================
   ADMINISTRACION — solo para quien esta en el secreto ADMIN
   ===========================================================================
   El modulo se importa perezoso y solo si eres tu: para los demas son diez
   kilobytes que no se descargan nunca. Que el boton este oculto no protege
   nada —el DOM se puede tocar— pero es que no hace falta: los endpoints de
   detras comprueban el secreto en cada llamada.
   =========================================================================== */
let adm = null;

async function prepararJefe() {
  $('#btn-admin').classList.remove('oculto');
  $('#btn-admin').addEventListener('click', abrirJefe);
  // Cuantos esperan, sin abrir la pantalla: si hay alguien, se ve al entrar.
  try {
    adm = await import('./admin.js');
    adm.prepararAdmin(pintarChincheta);
    pintarChincheta(await adm.cuantosPendientes());
  } catch { /* que falle esto no puede impedir usar la app */ }
}

async function abrirJefe() {
  if (!adm) { adm = await import('./admin.js'); adm.prepararAdmin(pintarChincheta); }
  adm.abrirAdmin();
}

function pintarChincheta(n) {
  const c = $('#admin-pendientes');
  c.textContent = n > 99 ? '99+' : String(n || '');
  c.classList.toggle('oculto', !n);
}

/* ===========================================================================
   PESTANAS
   =========================================================================== */
$$('.nav-item').forEach((b) => b.addEventListener('click', () => irA(b.dataset.tab)));

function irA(tab) {
  $$('.nav-item').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.panel').forEach(p => p.classList.toggle('oculto', p.dataset.panel !== tab));
  // Volver arriba al cambiar de pestana: heredar el scroll de la anterior
  // desorienta, sobre todo viniendo de una lista larga.
  window.scrollTo(0, 0);

  if (tab === 'cursos') cargarCursos();
  if (tab === 'rep')    cargarRepertorio();
  if (tab === 'rival')  cargarRival();
  if (tab === 'fichas') cargarFichas();
  if (tab === 'train')  cargarPendientes();
  if (tab === 'analisis') cargarAnalisis();
  if (tab === 'blind')  cargarBlind();
}

/* --- Blind (Fase 38) ------------------------------------------------------
   Modulo aparte y perezoso, como todas: trae la voz y el tablero solo a quien
   entra. Los cursos a ciegas los sigue jugando entrenar.js. */
async function cargarBlind() {
  // Los cursos a ciegas van por `entrenador()`, que es quien prepara la
  // sesion de entrenar.js una sola vez: importarlo a pelo desde blind.js la
  // dejaria sin preparar si no se ha pasado antes por Entrenar.
  (await import('./blind.js')).mostrarBlind({
    ciegas: async (ajustes) => (await entrenador()).entrenarCiegas(ajustes),
  });
}

/* --- El asistente ---------------------------------------------------------
   Carga perezosa de verdad: ni el modulo ni sus dos ficheros de datos se piden
   hasta que alguien toca la burbuja por primera vez. Quien no la use no paga
   nada por tenerla ahi.

   `irA` se le pasa como argumento en vez de exportarla: asi el asistente no
   importa este fichero y no hay dependencia circular entre el esqueleto y una
   pantalla suya. */
/* --- Entrenar: entrenar u objetivos ---------------------------------------
   `progreso.js` no se pide hasta que se toca «Objetivos». Quien solo entrena no
   paga por una pantalla que no abre, y quien la abre la recarga cada vez que
   vuelve: acaba de entrenar, y lo que quiere ver es el numero ya subido. */
let progreso = null;

$('#tr-vistas').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tren]');
  if (!b) return;
  const v = b.dataset.tren;
  $$('#tr-vistas [data-tren]').forEach(x =>
    x.setAttribute('aria-selected', String(x.dataset.tren === v)));
  $('#tr-entrenar').classList.toggle('oculto', v !== 'entrenar');
  $('#obj-cuerpo').classList.toggle('oculto', v === 'entrenar');
  if (v !== 'objetivos') return;
  if (!progreso) {
    progreso = await import('./progreso.js');
    progreso.prepararObjetivos();
  }
  progreso.cargarObjetivos();
});

$('#burbuja').addEventListener('click', async () => {
  const { abrirAsistente } = await import('./asistente.js');
  abrirAsistente({ irA });
});


/* ===========================================================================
   INICIO
   =========================================================================== */
async function cargarInicio() {
  // En paralelo y tolerante a fallos: que la cuenta de flashcards falle no
  // debe dejar en blanco la de cursos.
  const [cursos, repertorio, due] = await Promise.allSettled([
    api('cursos'), api('repertoire'), api('trainer/due?limit=1'),
  ]);
  const n = (r, f) => (r.status === 'fulfilled' ? f(r.value) : '–');
  $('#n-cursos').textContent = n(cursos, v => v.cursos.length);
  $('#n-rep').textContent    = n(repertorio, v => v.cursos.length + v.lineas.length);
  $('#n-due').textContent    = n(due,    v => v.total);
  cargarSugerencia();
}

/* --- Cuenta de Chess.com --------------------------------------------------
   Solo se guarda el nombre. No hay OAuth con Chess.com porque no hace falta
   para nada de lo que hace la app: su API publica sirve las partidas de
   cualquiera sin autenticar, asi que pedir permisos a la cuenta seria pedir
   mas de lo que se usa. Lo que cambia respecto a teclearlo cada vez es que el
   boton «yo» de la pestana Rival aparece, y que las pantallas de repertorio lo
   tendran cuando les toque cruzar tus propias partidas.
   ------------------------------------------------------------------------- */
function pintarChesscom() {
  const cuerpo = $('#cc-cuerpo');
  if (!cuerpo) return;

  cuerpo.innerHTML = `
    <div class="fila" style="align-items:flex-end;gap:8px">
      <div class="campo crece">
        <label for="cc-nuevo">Usuario</label>
        <input id="cc-nuevo" class="mono" autocomplete="off" autocapitalize="none"
               spellcheck="false" maxlength="25" placeholder="tu-usuario"
               value="${escapar(usuario.chesscom || '')}">
      </div>
      <button class="btn btn-peq" id="btn-cc" type="button">Guardar</button>
    </div>
    <div id="aviso-cc" class="aviso oculto"></div>
    <p class="legal" style="text-align:left;margin:0">
      Sirve para analizarte a ti mismo en la pestaña Rival sin teclearlo cada
      vez. Tus partidas de Chess.com son públicas: la app no pide permisos a tu
      cuenta ni guarda ninguna contraseña.
    </p>`;

  $('#btn-cc').addEventListener('click', async () => {
    limpiarAviso('#aviso-cc');
    const v = $('#cc-nuevo').value.trim().replace(/^@/, '');
    if (v && !/^[A-Za-z0-9_-]{3,25}$/.test(v)) {
      return aviso('#aviso-cc', 'Entre 3 y 25 caracteres: letras, dígitos, guión y guión bajo.');
    }
    try {
      await conBoton('#btn-cc', '…', () =>
        api('me', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chesscom: v }),
        }));
      usuario.chesscom = v || null;
      pintarChesscom();
    } catch (err) { aviso('#aviso-cc', err.message); }
  });

  // El atajo de la pestana Rival. Vive aqui y no en rival.js porque quien sabe
  // quien eres es esta pantalla: rival.js solo sabe de rivales.
  const yo = $('#cc-yo');
  if (!yo) return;
  yo.classList.toggle('oculto', !usuario.chesscom);
  if (usuario.chesscom) yo.textContent = 'Yo';
}

$('#cc-yo')?.addEventListener('click', () => {
  if (!usuario?.chesscom) return;
  $('#cc-usuario').value = usuario.chesscom;
  $('#form-chesscom').requestSubmit();
});

/* --- Ficha FIDE ---------------------------------------------------------- */
/**
 * Tres estados, no dos. Un ID FIDE confirmado por Lichess no es lo mismo que
 * uno tecleado por el usuario: el primero lo respalda un tercero y basta para
 * que sus partidas cedidas se promocionen; el segundo, no.
 */
function pintarFide() {
  const caja = $('#tarjeta-fide'), cuerpo = $('#fide-cuerpo');
  caja.classList.remove('oculto');

  if (usuario.fide_id && usuario.fide_origen === 'lichess') {
    cuerpo.innerHTML =
      `<div class="fila"><span class="mono crece">${escapar(usuario.fide_id)}</span>` +
      `<span class="etiqueta ok">confirmada por Lichess</span></div>` +
      `<p class="legal" style="text-align:left;margin:8px 0 0">` +
      `La trae tu perfil de Lichess. Para cambiarla, cámbiala allí.</p>`;
    return;
  }

  const pistas = [usuario.nombre, usuario.pais, usuario.titulo,
                  usuario.elo_fide && `${usuario.elo_fide} Elo`].filter(Boolean);

  cuerpo.innerHTML = `
    ${usuario.fide_id
      ? `<div class="fila"><span class="mono crece">${escapar(usuario.fide_id)}</span>
           <span class="etiqueta brass">declarada por ti</span></div>`
      : `<p style="margin:0;font-size:14px;line-height:1.6;color:var(--muted)">
           Sin ficha FIDE no se pueden cruzar tus partidas de torneo ni las de tus
           rivales. ${pistas.length
             ? `Sabemos esto de ti: <b style="color:var(--paper)">${escapar(pistas.join(' · '))}</b>.`
             : ''}
         </p>`}
    <div class="fila" style="align-items:flex-end;gap:8px">
      <div class="campo crece">
        <label for="fide-nuevo">ID FIDE</label>
        <input id="fide-nuevo" class="mono" inputmode="numeric" maxlength="10"
               placeholder="2200123" value="${escapar(usuario.fide_id || '')}">
      </div>
      <button class="btn btn-peq" id="btn-fide" type="button">Guardar</button>
    </div>
    <div id="aviso-fide" class="aviso oculto"></div>
    <p class="legal" style="text-align:left;margin:0">
      Lo más cómodo es vincularla en tu perfil de Lichess: entonces llega sola y
      queda confirmada. Buscarla por nombre desde aquí llegará con el volcado del
      censo FIDE.
    </p>`;

  $('#btn-fide').addEventListener('click', async () => {
    limpiarAviso('#aviso-fide');
    const v = $('#fide-nuevo').value.trim();
    if (v && !/^\d{4,10}$/.test(v)) return aviso('#aviso-fide', 'Deben ser entre 4 y 10 dígitos.');
    try {
      await conBoton('#btn-fide', '…', () =>
        api('me', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fide_id: v }),
        }));
      usuario.fide_id = v || null;
      usuario.fide_origen = v ? 'declarado' : null;
      pintarFide();
    } catch (err) { aviso('#aviso-fide', err.message); }
  });
}

/* --- Cesion de partidas -------------------------------------------------- */
$('#cede').addEventListener('change', async (e) => {
  const valor = e.target.checked;
  try {
    await api('me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cede: valor }),
    });
    usuario.cede = valor;
  } catch {
    // Revertir el interruptor si el servidor no lo acepto: dejarlo marcado
    // haria creer al usuario que ha consentido algo que no se ha guardado.
    e.target.checked = !valor;
  }
});

/* ===========================================================================
   CURSOS
   =========================================================================== */
let cursosCache = [];

/* El tablero de «qué cursos llegan aquí». Lo tiene todo el mundo con sus
   propios cursos. */
let cpos = null;
async function abrirCursosPorPosicion() {
  if (!cpos) cpos = await import('./cursospos.js');
  cpos.prepararCursosPos(usuario);
  return cpos.abrirCursosPos();
}
$('#cursos-vistas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cvista]');
  if (!b) return;
  const tablero = b.dataset.cvista === 'tablero';
  for (const x of document.querySelectorAll('#cursos-vistas [data-cvista]')) {
    x.setAttribute('aria-selected', String((x.dataset.cvista === 'tablero') === tablero));
  }
  $('#cursos-tablero').classList.toggle('oculto', !tablero);
  $('#cursos-lista-parte').classList.toggle('oculto', tablero);
  window.scrollTo(0, 0);
  if (tablero) abrirCursosPorPosicion();
});
// Añadir un curso desde esa pantalla tiene que refrescar la lista de Cursos.
document.addEventListener('openingchessai:cursos-cambiados', () => { cargarCursos(); cargarInicio(); });

async function cargarCursos() {
  const caja = $('#lista-cursos');
  caja.innerHTML = '<div class="vacio">Cargando…</div>';
  try {
    const { cursos } = await api('cursos');
    cursosCache = cursos;
    if (!cursos.length) {
      caja.innerHTML = '<div class="vacio">Todavía no has subido ningún PGN.<br>' +
                       'Sube el de una apertura que juegues y empieza por ahí.</div>';
      return;
    }
    caja.innerHTML = cursos.map(c => `
      <div class="item">
        <button class="item-abrir crece" data-id="${c.id}">
          <div class="t recorta">${escapar(c.nombre)}</div>
          <div class="s">${c.n_partidas} ${c.n_partidas === 1 ? 'partida' : 'partidas'} ·
               ${tamano(c.bytes)} · ${(c.subido_en || '').slice(0, 10)}</div>
        </button>
        <span class="etiqueta ${c.color === 'white' ? 'blancas' : 'negras'}">
          ${c.color === 'white' ? 'Blancas' : 'Negras'}</span>
        <button class="icono" data-borrar="${c.id}" aria-label="Borrar curso" title="Borrar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>
        </button>
      </div>`).join('');
  } catch (err) {
    caja.innerHTML = `<div class="vacio">No se pudo cargar: ${escapar(err.message)}</div>`;
  }
}

$('#lista-cursos').addEventListener('click', async (e) => {
  const abrir = e.target.closest('.item-abrir');
  if (abrir) {
    const c = cursosCache.find(x => x.id === abrir.dataset.id);
    if (!c) return;
    if (!visor) {
      visor = await import('./visor.js');
      visor.prepararVisor();
    }
    return visor.abrirVisor(c);
  }

  const borrar = e.target.closest('[data-borrar]');
  if (borrar) {
    const id = borrar.dataset.borrar;
    const c = cursosCache.find(x => x.id === id);
    // confirm() bloquea el hilo pero es lo unico que garantiza que un borrado
    // no ocurra por un roce en el bolsillo. Un modal propio seria mas bonito y
    // menos fiable.
    if (!confirm(`¿Borrar «${c?.nombre || 'el curso'}»? No se puede deshacer.`)) return;
    try {
      await api(`cursos/${id}`, { method: 'DELETE' });
      await borrarArbol(id);
      cargarCursos(); cargarInicio();
    } catch (err) { alert('No se pudo borrar: ' + err.message); }
  }
});

/* --- El filtro del selector de ficheros -----------------------------------
   `accept` se pone DESDE AQUI y solo fuera de Android, en vez de escribirlo en
   el HTML.

   En Android el selector de ficheros filtra por tipo MIME y `.pgn` no tiene
   ninguno registrado: con `accept` puesto, los PGN salen en gris y no hay forma
   de elegirlos —eso costo un rato de descubrir—. En Chrome de escritorio, en
   cambio, `accept=".pgn"` hace justo lo que uno espera: enseña solo los PGN.

   Asi que cada uno se lleva lo suyo, sin quitarle a Android el arreglo que ya
   tenia. Se dejan pasar tambien los .txt porque hay gestores que renombran. */
if (!/android/i.test(navigator.userAgent)) {
  $('#pgn')?.setAttribute('accept', '.pgn,.txt,application/x-chess-pgn');
}

$('#form-curso').addEventListener('submit', async (e) => {
  e.preventDefault();
  limpiarAviso('#aviso-curso');
  const fichero = $('#pgn').files[0];
  if (!fichero) return aviso('#aviso-curso', 'Elige un fichero.');

  // Se avisa, pero no se bloquea: hay gestores de ficheros que renombran a .txt
  // y el servidor comprueba de todas formas que dentro haya cabeceras [Event].
  if (!/\.(pgn|txt)$/i.test(fichero.name)) {
    aviso('#aviso-curso', `«${fichero.name}» no parece un PGN. Se intenta igual…`, '');
  }
  if (fichero.size > TOPE_PGN) {
    return aviso('#aviso-curso',
      `Ese fichero ocupa ${tamano(fichero.size)} y el tope son ${tamano(TOPE_PGN)}. ` +
      `Pártelo en varios cursos: además se entrenan mejor por separado.`);
  }

  const datos = new FormData();
  datos.append('color', $('#color-curso').value);
  try {
    const r = await conBoton('#btn-curso', 'Subiendo…', async () => {
      /* SE LEE EL FICHERO UNA SOLA VEZ Y SE SUBE DESDE MEMORIA.
       *
       * Lo evidente seria pasarle el File a FormData y que el navegador lo
       * lea al enviarlo. En Android eso falla: el selector devuelve un
       * `content://` de un proveedor —Drive, Descargas, el gestor de turno— y
       * hay proveedores que solo dejan abrir el fichero UNA vez. Si aqui se
       * cuenta leyendo el flujo y luego el envio vuelve a leerlo, la segunda
       * lectura se cae, `fetch` se rechaza y todo lo que llega arriba es «sin
       * conexion» con la conexion perfecta.
       *
       * Leyendolo una vez y mandando esos bytes, la subida ya no depende del
       * fichero original: da igual que el proveedor lo cierre, que el usuario
       * lo mueva o que estuviera solo en la nube. Y de paso el recuento sale
       * de la misma lectura, gratis.
       */
      $('#btn-curso').textContent = 'Leyendo…';
      let cuerpo, n;
      if (fichero.size <= TOPE_MEMORIA) {
        const texto = await fichero.text();
        n = (texto.match(/^\[Event\s/gmi) || []).length;
        cuerpo = new Blob([texto], { type: 'application/x-chess-pgn' });
      } else {
        // Por encima del tope no cabe en una cadena en un movil modesto: se
        // cuenta por trozos y se sube el fichero tal cual, asumiendo el riesgo
        // de la segunda lectura. Un PGN asi no sale de Drive, sale del disco.
        n = await contarPartidas(fichero);
        cuerpo = fichero;
      }
      // El tercer argumento es el nombre: sin el, un Blob viaja como «blob» y
      // el curso se guardaria sin su titulo.
      datos.append('pgn', cuerpo, fichero.name || 'curso.pgn');
      datos.append('n_partidas', String(n));
      $('#btn-curso').textContent = 'Subiendo…';
      return api('cursos', { method: 'POST', body: datos });
    });
    aviso('#aviso-curso',
      `Subido: ${r.n_partidas} ${r.n_partidas === 1 ? 'partida' : 'partidas'}. Ábrelo para verlo en el tablero.`,
      'bien');
    $('#form-curso').reset();
    cargarCursos(); cargarInicio();
  } catch (err) {
    // «Sin conexión» a secas, subiendo un fichero, manda a mirar el wifi cuando
    // el problema puede ser otro. Si el navegador dice que hay red, se dice.
    // Con el motivo de verdad delante, en vez de «vuelve a intentarlo». Casi
    // siempre el problema no es la red: es que el movil ya no puede leer el
    // fichero que elegiste.
    const causa = err.causa ? `${err.causa.name}: ${err.causa.message}` : null;
    aviso('#aviso-curso', err.message === 'sin conexión' && navigator.onLine !== false
      ? `No se ha podido enviar «${fichero.name}» (${tamano(fichero.size)}). ` +
        'Si lo elegiste desde Drive o Descargas, cópialo antes a la memoria del ' +
        'teléfono y vuelve a intentarlo.' + (causa ? ` [${causa}]` : '')
      : err.message);
  }
});

/* El tope. No es el limite de Cloudflare —que son 100 MB— sino uno con margen:
   un PGN de mas de esto no es un curso de aperturas, es una base de datos, y no
   hay movil que construya ese arbol sin quedarse sin memoria al abrirlo. */
const TOPE_PGN = 40 * 1024 * 1024;

/* Por debajo de esto el PGN se lee entero en memoria y se sube desde ahi, que
   es lo que hace la subida inmune a los proveedores de fichero de Android.
   Veinticinco megas de texto son cincuenta en memoria por ser UTF-16: mucho,
   pero puntual y solo mientras dura el envio. */
const TOPE_MEMORIA = 25 * 1024 * 1024;

/**
 * Cuenta las partidas de un PGN sin cargarlo entero en memoria.
 *
 * Por trozos y no con `fichero.text()` y un `match`: el texto de un PGN de 40
 * MB son 80 en memoria por ser UTF-16, y eso en un movil con la app abierta es
 * pedir que lo mate el sistema. Asi el gasto es constante.
 */
async function contarPartidas(fichero) {
  const lector = fichero.stream().pipeThrough(new TextDecoderStream()).getReader();
  let n = 0, resto = '';
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    const lineas = (resto + value).split('\n');
    // La ultima puede estar cortada por la mitad: se guarda para el trozo que
    // viene. Sin esto, una cabecera partida en dos lecturas no se cuenta.
    resto = lineas.pop();
    for (const l of lineas) if (/^\[Event\s/i.test(l)) n++;
  }
  if (/^\[Event\s/i.test(resto)) n++;
  return n;
}

/* --- Sugerencia del dia ---------------------------------------------------
   Se calcula en el movil, no en el cron: el arbol del repertorio vive en
   IndexedDB de este navegador. Ver sugerencia.js. */
let sug = null;
async function cargarSugerencia({ forzar = false } = {}) {
  const caja = $('#sugerencia');
  if (!sug) sug = await import('./sugerencia.js');
  sug.pintarSugerencia(caja, { estado: 'cargando' });
  try {
    const dato = await sug.sugerenciaDeHoy({ forzar });
    sug.pintarSugerencia(caja, dato, () => cargarSugerencia({ forzar: true }));
  } catch (err) {
    sug.pintarSugerencia(caja, { estado: 'error', mensaje: err.message });
  }
}

/* ===========================================================================
   REPERTORIO — vive en su propio modulo, se carga al entrar en la pestana
   =========================================================================== */
let rep = null;
let elite = null;
let mirep = null;
async function cargarRepertorio() {
  if (!rep) {
    rep = await import('./repertorio.js');
    // Las partidas de elite y el repertorio sacado de tus propias partidas
    // viven en la misma pestana y comparten el repertorio marcado, asi que se
    // preparan a la vez.
    elite = await import('./eliterep.js');
    elite.prepararElite();
    mirep = await import('./mirepertorio.js');
    // Al guardar lineas cambia el repertorio: hay que repintar la pestana y las
    // cifras del inicio.
    mirep.prepararMiRepertorio(() => { rep.mostrarRepertorio(); cargarInicio(); });
    rep.prepararRepertorio(cargarInicio);
  }
  // Las tres en paralelo: ni la de elite ni la de tus partidas salen a la red
  // hasta que se les pide, asi que no retrasan la pestana.
  const r = rep.mostrarRepertorio();
  elite.mostrarElite().catch(() => {});
  mirep.mostrarMiRepertorio(usuario);
  return r;
}

/* ===========================================================================
   RIVAL — igual que Repertorio: modulo aparte y carga perezosa. Es el mas
   pesado de todos (trae chess.js y levanta un worker) y la mayoria de las
   sesiones no pasan por el.
   =========================================================================== */
let riv = null;
async function cargarRival() {
  if (riv) return;
  riv = await import('./rival.js');
  riv.prepararRival();
  // El libro se engancha aqui y no dentro de rival.js para que los dos modulos
  // se preparen una sola vez y en el mismo sitio: rival.js lo IMPORTA para
  // abrirlo, pero quien es dueno del ciclo de vida de las pantallas es esto.
  (await import('./librorival.js')).prepararLibro();
}

/* ===========================================================================
   ENTRENAR — modulo aparte: trae el tablero, chess.js y la cola de repasos
   =========================================================================== */
let ent = null;
async function entrenador() {
  if (!ent) {
    ent = await import('./entrenar.js');
    ent.prepararEntrenar(cargarInicio);
  }
  return ent;
}

async function cargarPendientes() {
  return (await entrenador()).mostrarEntrenar();
}

/* ===========================================================================
   FICHAS — el fichero de posiciones falladas, con sus filtros
   ===========================================================================
   La pestaña elige QUE se repasa; la sesion de repaso sigue siendo la de
   Entrenar, porque es el mismo tablero, la misma pista y la misma cola. Por
   eso al preparar Fichas se le pasa el arranque del entrenador: no hay dos
   sesiones, hay dos formas de entrar en la misma.
   =========================================================================== */
let fic = null;
async function cargarFichas() {
  if (!fic) {
    fic = await import('./flashcards.js');
    fic.prepararFichas(async (cartas) => (await entrenador()).repasarFichas(cartas));
  }
  return fic.mostrarFichas();
}

/* ===========================================================================
   ANALISIS — tus partidas (Fase 27). Modulo aparte y perezoso, como Rival.
   Se le pasa `usuario` porque las cuentas guardadas en Inicio —Lichess,
   Chess.com, FIDE— son justo con las que se rellena el formulario.
   =========================================================================== */
let ana = null;
async function cargarAnalisis() {
  if (!ana) ana = await import('./analisis.js');
  ana.prepararAnalisis(usuario, { alCambiar: () => { pintarFide(); pintarChesscom(); } });
  return ana.mostrarAnalisis();
}

/* Service worker: se registra siempre, tambien sin sesion, porque el shell
   cacheado es justo lo que hace que la app abra al instante la segunda vez. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}


/* ===========================================================================
   MODO DIA Y NOCHE
   ===========================================================================
   Tres estados y no dos: claro, oscuro y "el que diga el sistema". El tercero
   es el que acierta a las ocho de la tarde sin que nadie toque nada, asi que
   es el que hay hasta que alguien elige.

   El boton alterna entre claro y oscuro tomando como punto de partida lo que
   se este viendo AHORA, no lo que hubiera guardado: si vas en automatico y es
   de noche, el primer toque enciende la luz, que es lo que espera la mano.

   Se aplica en <html> y no en <body> porque el navegador pinta el fondo de la
   pagina a partir de la raiz: puesto en body, al abrir quedaba una franja del
   color anterior arriba y abajo durante el primer repintado.
   =========================================================================== */
const CLAVE_TEMA = 'tema';

/** El color de la barra del sistema tiene que ir a juego con el fondo. */
function temaColor() {
  const c = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c || '#0E1618');
}

export function aplicarTema() {
  let t = null;
  try { t = localStorage.getItem(CLAVE_TEMA); } catch { /* modo privado */ }
  if (t === 'claro' || t === 'oscuro') document.documentElement.dataset.tema = t;
  else delete document.documentElement.dataset.tema;
  temaColor();
}

function alternarTema() {
  // Lo que se ve ahora mismo, venga de donde venga: si estamos en automatico,
  // esto lo resuelve el propio navegador y no hay que adivinarlo.
  const oscuroAhora = getComputedStyle(document.documentElement)
    .getPropertyValue('color-scheme').trim().includes('dark');
  const nuevo = oscuroAhora ? 'claro' : 'oscuro';
  try { localStorage.setItem(CLAVE_TEMA, nuevo); } catch { /* modo privado */ }
  document.documentElement.dataset.tema = nuevo;
  temaColor();
}

// Antes de nada: si se aplica despues de pintar, se ve el destello del tema
// contrario.
aplicarTema();
// Y si el usuario nunca ha elegido, seguir al sistema cuando cambie solo.
window.matchMedia?.('(prefers-color-scheme: dark)')
  .addEventListener?.('change', () => { if (!document.documentElement.dataset.tema) temaColor(); });
