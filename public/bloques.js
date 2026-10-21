/* ===========================================================================
   OpeningChessAI — bloques de apertura.

   Rangos ECO -> familia. Agrupar por ECO suelto no sirve para preparar: B90 y
   B96 son las dos Najdorf, y separarlas parte el recuento en trozos que no
   dicen nada. El bloque es la unidad con la que se piensa una partida antes de
   jugarla. La tabla viene del trabajo que ya estaba hecho en
   aplicar_bloques_rival.py.

   Vive en su propio modulo porque lo usan tres: el analisis del rival, el
   libro del rival y la pestana que los pinta. Tenerlo duplicado garantizaba
   que un dia alguien arreglase un rango en un sitio y no en los otros.
   =========================================================================== */

export const BLOQUES = [
  ['A00', 'A09', 'A0',  'Aperturas irregulares'],
  ['A10', 'A39', 'A1',  'Inglesa'],
  ['A40', 'A44', 'A4',  'Defensas irregulares contra 1.d4'],
  ['A45', 'A49', 'A45', 'Sistemas con 1.d4 Cf6'],
  ['A50', 'A79', 'A5',  'Benoni e India antigua'],
  ['A80', 'A99', 'A8',  'Holandesa'],
  ['B00', 'B09', 'B0',  'Alekhine, Pirc y Moderna'],
  ['B10', 'B19', 'B1',  'Caro-Kann'],
  ['B20', 'B99', 'B2',  'Siciliana'],
  ['C00', 'C19', 'C0',  'Francesa'],
  ['C20', 'C59', 'C2',  'Aperturas abiertas'],
  ['C60', 'C99', 'C6',  'Española'],
  ['D00', 'D05', 'D0',  'Sistemas con 1.d4 d5'],
  ['D06', 'D69', 'D1',  'Gambito de dama'],
  ['D70', 'D99', 'D7',  'Grünfeld'],
  ['E00', 'E09', 'E0',  'Catalana'],
  ['E10', 'E19', 'E1',  'India de dama'],
  ['E20', 'E59', 'E2',  'Nimzoindia'],
  ['E60', 'E99', 'E6',  'India de rey'],
];

/** ECO -> [clave del bloque, nombre]. */
export function bloqueDe(eco) {
  const e = String(eco || '').trim().toUpperCase().slice(0, 3);
  if (!/^[A-E]\d\d$/.test(e)) return ['??', 'Sin clasificar'];
  for (const [i, f, b, n] of BLOQUES) if (e >= i && e <= f) return [b, n];
  return ['??', 'Sin clasificar'];
}
