/* ===========================================================================
   OpeningChessAI — la puerta, desde dentro.

   Una pantalla para una sola persona: quien tenga su usuario en el secreto
   ADMIN del Worker. Para todos los demas este modulo ni siquiera se descarga,
   porque el boton que lo importa esta oculto y los cinco endpoints de detras
   contestan 403 aunque alguien los llame a mano. Esto es comodidad, no
   seguridad: la seguridad esta en el servidor.

   Dos listas y ya:

     INVITADOS   gente que todavia no se ha registrado y a la que quieres que
                 le entre directo. Se apunta el correo o el usuario de Lichess
                 y, cuando se registre, entra ya activo.

     USUARIOS    los que ya estan. Aprobar, bloquear y una nota para acordarse
                 de quien es cada cual dentro de seis meses.

   Bloquear y no borrar. Borrar es irreversible y se hace con la mano temblando
   a las once de la noche; bloquear deja la puerta cerrada y los datos donde
   estaban, y se deshace con un toque si te equivocaste de fila.
   =========================================================================== */

import { $, $$, api, aviso, limpiarAviso, conBoton, escapar } from './comun.js';

let usuarios = [];
let filtro = 'pendiente';
let alCambiar = null;   // avisar al esqueleto para repintar la chincheta

export function prepararAdmin(cb) {
  alCambiar = cb;
  $('#ad-cerrar').addEventListener('click', cerrar);
  $('#ad-recargar').addEventListener('click', () => cargar());
  $('#form-invitar').addEventListener('submit', invitar);

  $$('#ad-filtros [data-filtro]').forEach(b => b.addEventListener('click', () => {
    filtro = b.dataset.filtro;
    $$('#ad-filtros [data-filtro]').forEach(x =>
      x.setAttribute('aria-selected', String(x.dataset.filtro === filtro)));
    pintarUsuarios();
  }));

  $('#ad-usuarios').addEventListener('click', accionUsuario);
  $('#ad-invitados').addEventListener('click', borrarInvitado);
}

export function abrirAdmin() {
  $('#admin').classList.remove('oculto');
  document.body.classList.add('sin-scroll');
  cargar();
}

function cerrar() {
  $('#admin').classList.add('oculto');
  document.body.classList.remove('sin-scroll');
}

/* ===========================================================================
   Cargar
   =========================================================================== */
async function cargar() {
  $('#ad-usuarios').innerHTML = '<div class="vacio">Cargando…</div>';
  // Las dos a la vez y por separado: que la lista de invitados falle no debe
  // dejar sin aprobar a nadie.
  const [u, i, m] = await Promise.allSettled([
    api('admin/usuarios'), api('admin/invitados'), api('admin/metricas')]);
  pintarMetricas(m.status === 'fulfilled' ? m.value : null);

  if (u.status === 'fulfilled') { usuarios = u.value.usuarios || []; pintarUsuarios(); }
  else $('#ad-usuarios').innerHTML =
    `<div class="vacio">No se pudo cargar: ${escapar(u.reason.message)}</div>`;

  pintarInvitados(i.status === 'fulfilled' ? i.value.invitados || [] : []);
  alCambiar?.(usuarios.filter(x => (x.estado || 'pendiente') === 'pendiente').length);
}

/* ===========================================================================
   Uso y errores (Fase 33)
   ===========================================================================
   Lo minimo para saber si la app se usa y si falla. Sin graficos: con un
   punado de usuarios, una linea con el numero dice mas que una barra. */
const miles = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function pintarMetricas(d) {
  const caja = $('#ad-metricas');
  if (!d) { caja.innerHTML = '<h3>Uso</h3><div class="s">No se pudieron cargar las métricas.</div>'; return; }
  const u = d.usuarios || {}, r = d.repasos7 || {}, c = d.cursos || {};
  const pct = r.n ? Math.round((r.aciertos / r.n) * 100) : 0;
  const dias = (d.porDia || []).map(x =>
    `<div class="fila" style="gap:8px"><span class="mono s" style="width:86px">${escapar(x.dia)}</span>` +
    `<span class="crece s">${miles(x.n)} repasos · ${x.usuarios} ${x.usuarios === 1 ? 'usuario' : 'usuarios'}</span></div>`).join('');
  const errores = (d.errores || []).map(e =>
    `<div class="item" style="align-items:flex-start">
       <span class="etiqueta mal">${miles(e.n)}</span>
       <div class="crece"><div class="t" style="word-break:break-word">${escapar(e.mensaje)}</div>
         <div class="s mono">${escapar(e.donde)} · ${escapar(e.dia)}</div></div></div>`).join('');
  caja.innerHTML = `
    <h3>Uso</h3>
    <div class="s">Usuarios: <b>${u.activo || 0}</b> activos · ${u.pendiente || 0} pendientes · ${u.bloqueado || 0} bloqueados</div>
    <div class="s">Entraron: ${d.entraron?.d7 || 0} en 7 días · ${d.entraron?.d30 || 0} en 30 días</div>
    <div class="s">Repasos en 7 días: <b>${miles(r.n)}</b> de ${r.usuarios || 0} ${r.usuarios === 1 ? 'usuario' : 'usuarios'} · ${pct} % de aciertos</div>
    <div class="s">Cursos: ${miles(c.n)} de ${c.usuarios || 0} usuarios · ${((c.bytes || 0) / 1048576).toFixed(1)} MB</div>
    <div class="s">Asistente: ${miles(d.chatHoy)} mensajes hoy al modelo (tope 250) · voz por Whisper: ${miles(d.vozHoy || 0)} frases (tope 300)</div>
    ${dias ? `<details><summary class="s">Repasos por día (14 días)</summary>${dias}</details>` : ''}
    <h3 style="margin-top:6px">Errores en 7 días</h3>
    ${errores ? `<div class="lista">${errores}</div>`
              : '<div class="s">Ninguno apuntado. Se guardan sin usuario y un mes como mucho.</div>'}`;
}

/** Cuantos esperan. Se pide aparte al arrancar la app, sin abrir la pantalla. */
export async function cuantosPendientes() {
  const { usuarios: u } = await api('admin/usuarios');
  usuarios = u || [];
  return usuarios.filter(x => (x.estado || 'pendiente') === 'pendiente').length;
}

/* ===========================================================================
   Usuarios
   =========================================================================== */
function pintarUsuarios() {
  const lista = usuarios.filter(u => (u.estado || 'pendiente') === filtro);
  const caja = $('#ad-usuarios');

  if (!lista.length) {
    caja.innerHTML = `<div class="vacio">${
      filtro === 'pendiente' ? 'Nadie esperando. Todo al día.'
      : filtro === 'activo'  ? 'Todavía no has aprobado a nadie.'
      : 'No has bloqueado a nadie.'}</div>`;
    return;
  }

  caja.innerHTML = lista.map(u => {
    // Quien es: lo que haya. Un usuario de Lichess sin nombre ni correo sigue
    // siendo identificable por su usuario, y es lo unico que se va a tener de
    // mucha gente.
    const quien = u.nombre || u.lichess || u.email || '(sin nombre)';
    const segunda = [
      u.lichess && u.nombre ? `lichess: ${u.lichess}` : null,
      u.email && u.email !== quien ? u.email : null,
      u.fide_id ? `FIDE ${u.fide_id}${u.fide_origen === 'lichess' ? ' ✓' : ''}` : null,
      u.titulo, u.elo_fide ? `${u.elo_fide} Elo` : null, u.pais,
    ].filter(Boolean).join(' · ');

    // Los datos ocupan la fila entera y los botones caen debajo: en un movil de
    // 360 puntos, tres botones al lado del nombre dejaban el nombre en «Ana R…»
    // y la fecha en «alta 2026-…», que es justo lo que hay que leer para
    // decidir.
    return `<div class="item" style="flex-wrap:wrap;align-items:stretch">
      <div style="flex:1 1 100%;min-width:0">
        <div class="t recorta">${escapar(quien)}</div>
        <div class="s recorta">${escapar(segunda || '—')}</div>
        <div class="s" style="color:var(--muted)">
          alta ${escapar((u.creado_en || '').slice(0, 10))}${
            u.visto_en ? ` · visto ${escapar(u.visto_en.slice(0, 10))}` : ''}${
            u.aprobado_en ? ` · aprobado ${escapar(u.aprobado_en.slice(0, 10))}` : ''}</div>
        ${u.nota_admin ? `<div class="s" style="color:var(--brass)">${escapar(u.nota_admin)}</div>` : ''}
      </div>
      <div class="fila" style="gap:6px;flex:1 1 100%;margin-top:8px">
        ${filtro !== 'activo'
          ? `<button class="btn btn-peq crece" data-id="${escapar(u.id)}" data-estado="activo">Aprobar</button>` : ''}
        ${filtro !== 'bloqueado'
          ? `<button class="btn btn-peq btn-sutil crece" data-id="${escapar(u.id)}" data-estado="bloqueado">Bloquear</button>` : ''}
        <button class="btn btn-peq btn-sutil" data-id="${escapar(u.id)}" data-nota="1">Nota</button>
      </div>
    </div>`;
  }).join('');
}

async function accionUsuario(e) {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  const id = b.dataset.id;
  const u = usuarios.find(x => x.id === id);

  if (b.dataset.nota) {
    // prompt() es feo y sirve: son dos palabras para acordarse de quien es
    // alguien, y un modal propio para eso seria mas codigo que la pantalla.
    const v = prompt('Nota sobre esta persona:', u?.nota_admin || '');
    if (v === null) return;
    try {
      await api(`admin/usuarios/${id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nota: v }),
      });
      if (u) u.nota_admin = v || null;
      pintarUsuarios();
    } catch (err) { alert('No se pudo guardar: ' + err.message); }
    return;
  }

  const nuevo = b.dataset.estado;
  // Aprobar no se confirma: es el gesto que se repite y es reversible. Bloquear
  // si, porque el que lo nota es el otro.
  if (nuevo === 'bloqueado' &&
      !confirm(`¿Retirar el acceso a ${u?.nombre || u?.lichess || u?.email || 'esta persona'}?\n\n` +
               'Sus datos se quedan donde están y puedes devolvérselo cuando quieras.')) return;

  b.disabled = true;
  try {
    await api(`admin/usuarios/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ estado: nuevo }),
    });
    if (u) {
      u.estado = nuevo;
      if (nuevo === 'activo' && !u.aprobado_en) u.aprobado_en = new Date().toISOString();
    }
    pintarUsuarios();
    alCambiar?.(usuarios.filter(x => (x.estado || 'pendiente') === 'pendiente').length);
  } catch (err) {
    alert('No se pudo cambiar: ' + err.message);
  } finally { b.disabled = false; }
}

/* ===========================================================================
   Invitados
   =========================================================================== */
function pintarInvitados(lista) {
  const pendientes = lista.filter(i => !i.usado_en);
  $('#ad-invitados').innerHTML = !pendientes.length
    ? `<p class="legal" style="text-align:left;margin:0">No hay invitaciones sin usar.</p>`
    : pendientes.map(i => `
      <div class="item">
        <div class="crece" style="min-width:0">
          <div class="t recorta">${escapar(i.email || i.lichess)}</div>
          <div class="s">${escapar(i.email && i.lichess ? i.lichess : 'sin usar')}${
            i.nota ? ` · ${escapar(i.nota)}` : ''}</div>
        </div>
        <button class="icono" data-borrar-inv="${escapar(i.id)}" aria-label="Quitar invitación">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>`).join('');
}

async function invitar(e) {
  e.preventDefault();
  limpiarAviso('#aviso-invitar');
  const email   = $('#ad-email').value.trim();
  const lichess = $('#ad-lichess').value.trim();
  if (!email && !lichess) return aviso('#aviso-invitar', 'Pon al menos un correo o un usuario.');
  try {
    await conBoton('#btn-invitar', 'Invitando…', () =>
      api('admin/invitados', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, lichess, nota: $('#ad-nota').value.trim() }),
      }));
    aviso('#aviso-invitar', 'Invitado. Entrará directo en cuanto se registre.', 'bien');
    $('#form-invitar').reset();
    cargar();
  } catch (err) { aviso('#aviso-invitar', err.message); }
}

async function borrarInvitado(e) {
  const b = e.target.closest('[data-borrar-inv]');
  if (!b) return;
  try {
    await api(`admin/invitados/${b.dataset.borrarInv}`, { method: 'DELETE' });
    cargar();
  } catch (err) { alert('No se pudo quitar: ' + err.message); }
}
