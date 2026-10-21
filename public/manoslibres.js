/* ===========================================================================
   OpeningChessAI — manos libres (Fase 38).

   El bucle de voz de los repasos a ciegas, sacado de entrenar.js (Fase 37)
   para que lo usen igual los cursos y las fichas de tus partidas en la
   pestaña Blind. Cada pantalla pone SOLO lo suyo —que hacer con lo oido— y
   esto pone el resto:

     · hablar y DESPUES escuchar, nunca a la vez (el micro oiria al altavoz);
     · un turno por locucion: si mientras habla llega otra cosa que decir,
       solo la ultima abre el micro;
     · los silencios: a las cinco escuchas vacias pregunta si sigues ahi, a
       las veinte se apaga para no gastar bateria;
     · la pantalla despierta (Wake Lock) y el candado contra toques;
     · al irse de la app se calla y deja de escuchar; al volver, `alVolver`.

   Los elementos van por prefijo: `<p>-voz`, `<p>-bloquear`, `<p>-oido`, `<p>-guia`,
   `<p>-candado`, `<p>-candado-txt`, `<p>-candado-oido`.
   =========================================================================== */

import { $ } from './comun.js';
import { hablar, callar, escuchar, soltarMicro, mantenerDespierta, puedeEscuchar, puedeHablar } from './voz.js';

export const hayVoz = () => puedeHablar() && puedeEscuchar();

/**
 * @param p          prefijo de los ids
 * @param alOir      (textos) => void  — que hacer con una frase oida
 * @param alVolver   () => void        — al volver a la app con la voz puesta
 * @param alAviso    (texto) => void   — para enseñar un error en pantalla
 */
export function crearManosLibres({ p, alOir, alVolver = () => {}, alAviso = () => {} }) {
  let activa = false, oido = null, turno = 0, vacias = 0, ultimo = '';
  const el = (s) => $(`#${p}-${s}`);

  function pintar() {
    el('voz')?.classList.toggle('activo', activa);
    el('voz')?.setAttribute('aria-pressed', activa ? 'true' : 'false');
    el('bloquear')?.classList.toggle('oculto', !activa);
    el('oido')?.classList.toggle('oculto', !activa);
    el('guia')?.classList.toggle('oculto', !activa);
  }
  function verOido(t) {
    if (el('oido')) el('oido').textContent = t;
    if (el('candado-oido')) el('candado-oido').textContent = t;
  }

  function encender() {
    activa = true; vacias = 0;
    mantenerDespierta(true);
    pintar();
  }

  function apagar() {
    activa = false;
    oido?.abort(); oido = null;
    turno++;
    callar();
    soltarMicro();
    mantenerDespierta(false);
    bloquear(false);
    verOido('');
    pintar();
  }

  /** Dice algo y, al acabar, escucha. */
  async function decir(texto, opciones = {}) {
    if (!activa) return;
    oido?.abort();
    ultimo = texto;
    const mio = ++turno;
    if (el('candado-txt')) el('candado-txt').textContent = texto;
    verOido('🔊');
    await hablar(texto, opciones);
    if (!activa || turno !== mio) return;
    escucharYa();
  }

  /** Dice algo SIN escuchar despues (lo que venga detras abrira el micro). */
  function soloDecir(texto) {
    if (!activa) return Promise.resolve();
    oido?.abort();
    turno++;
    ultimo = texto;
    if (el('candado-txt')) el('candado-txt').textContent = texto;
    return hablar(texto);
  }

  async function escucharYa() {
    if (!activa) return;
    oido?.abort();
    const ctrl = oido = new AbortController();
    const mio = turno;
    verOido('🎙 Te escucho…');
    let r;
    try {
      r = await escuchar({ senal: ctrl.signal, alParcial: (t) => verOido('🎙 ' + t) });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const negado = /not-allowed|permission|denied/i.test(e.codigo || e.name || e.message);
      alAviso(negado ? 'No hay permiso para el micrófono. Actívalo en los ajustes del navegador para esta web.'
                     : `No puedo escuchar: ${e.message}`);
      apagar();
      hablar(negado ? 'No tengo permiso para el micrófono.' : 'No puedo escuchar. Apago la voz.');
      return;
    }
    if (ctrl.signal.aborted || !activa || turno !== mio) return;
    oido = null;
    if (!r.textos.length) {
      vacias++;
      if (vacias >= 20) { apagar(); hablar('No te oigo. Apago la voz.'); return; }
      if (vacias % 5 === 0) return decir('¿Sigues ahí? Di tu jugada, «repite», o «para».');
      return escucharYa();
    }
    vacias = 0;
    verOido(`Oído: «${r.textos[0]}»`);
    alOir(r.textos);
  }

  /** Corta la escucha en curso (una jugada tocada en el tablero). */
  function cortar() { oido?.abort(); oido = null; }

  function bloquear(si) {
    el('candado')?.classList.toggle('oculto', !si);
    if (si && el('candado-txt')) el('candado-txt').textContent = ultimo;
  }

  // El candado: se quita manteniendo el dedo un segundo.
  const c = el('candado');
  if (c) {
    let t = null;
    const soltar = () => { clearTimeout(t); c.classList.remove('apretando'); };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      c.classList.add('apretando');
      t = setTimeout(() => { soltar(); bloquear(false); }, 1000);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) c.addEventListener(ev, soltar);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  el('bloquear')?.addEventListener('click', () => bloquear(true));

  // Al irse de la app el sistema corta el micro. Al volver se retoma.
  document.addEventListener('visibilitychange', () => {
    if (!activa) return;
    if (document.visibilityState === 'hidden') { cortar(); turno++; callar(); return; }
    alVolver();
  });

  return {
    get activa() { return activa; },
    get ultimo() { return ultimo; },
    encender, apagar, decir, soloDecir, escuchar: escucharYa, cortar, bloquear, pintar,
  };
}
