/* ===========================================================================
   Genera y VERIFICA public/datos/aperturas-guia.json.

   Se ejecuta a mano, desde esta carpeta, cuando se quiera anadir o corregir una
   apertura de la guia del asistente:

       node herramientas/aperturas_guia.mjs

   Cada linea se reproduce con chess.js y se comprueba contra
   public/datos/aperturas.json: si el EPD final no tiene nombre en la tabla, la
   entrada NO se escribe y sale por pantalla como descartada. Asi no se publica
   una linea inventada, que en una pantalla de ayuda es el peor fallo posible.
   =========================================================================== */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SALIDA = path.join(AQUI, '..', 'public', 'datos', 'aperturas-guia.json');

import { Chess } from '../public/vendor/chess.js';
import fs from 'fs';

const tabla = JSON.parse(fs.readFileSync(SALIDA.replace('aperturas-guia', 'aperturas'), 'utf8'));
const epd = (f) => f.split(' ').slice(0, 4).join(' ');

const G = [
  ['Apertura de peón de rey', 'e4', []],
  ['Apertura de peón de dama', 'd4', []],
  ['Apertura Inglesa', 'c4', ['inglesa']],
  ['Apertura Reti', 'Nf3 d5 c4', ['reti', 'réti']],
  ['Apertura Bird', 'f4', ['bird']],
  ['Ataque indio de rey', 'Nf3 d5 g3', ['air', 'ataque indio']],
  ['Defensa Siciliana', 'e4 c5', ['siciliana']],
  ['Siciliana Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', ['najdorf']],
  ['Siciliana Dragón', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6', ['dragon', 'dragón']],
  ['Siciliana Scheveningen', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6', ['scheveningen']],
  ['Siciliana Sveshnikov', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5', ['sveshnikov']],
  ['Siciliana Taimánov', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6', ['taimanov', 'taimánov']],
  ['Siciliana Kan', 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6', ['kan']],
  ['Siciliana Dragón acelerado', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6', ['dragon acelerado', 'acelerado']],
  ['Siciliana Alapin', 'e4 c5 c3', ['alapin']],
  ['Siciliana Rossolimo', 'e4 c5 Nf3 Nc6 Bb5', ['rossolimo']],
  ['Siciliana Cerrada', 'e4 c5 Nc3', ['siciliana cerrada']],
  ['Gambito Smith-Morra', 'e4 c5 d4 cxd4 c3', ['morra', 'smith morra']],
  ['Defensa Francesa', 'e4 e6', ['francesa']],
  ['Francesa, variante del Avance', 'e4 e6 d4 d5 e5', ['francesa avance']],
  ['Francesa, variante Tarrasch', 'e4 e6 d4 d5 Nd2', ['tarrasch francesa']],
  ['Francesa, variante Winawer', 'e4 e6 d4 d5 Nc3 Bb4', ['winawer']],
  ['Francesa, variante Clásica', 'e4 e6 d4 d5 Nc3 Nf6', ['francesa clasica']],
  ['Francesa, variante del Cambio', 'e4 e6 d4 d5 exd5', ['francesa cambio']],
  ['Defensa Caro-Kann', 'e4 c6', ['caro kann', 'carokann', 'caro']],
  ['Caro-Kann, variante del Avance', 'e4 c6 d4 d5 e5', ['caro avance']],
  ['Caro-Kann, variante Clásica', 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5', ['caro clasica']],
  ['Caro-Kann, ataque Panov', 'e4 c6 d4 d5 exd5 cxd5 c4', ['panov']],
  ['Defensa Escandinava', 'e4 d5', ['escandinava', 'centro contra']],
  ['Defensa Alekhine', 'e4 Nf6', ['alekhine']],
  ['Defensa Pirc', 'e4 d6 d4 Nf6 Nc3 g6', ['pirc']],
  ['Defensa Moderna', 'e4 g6', ['moderna']],
  ['Defensa Nimzowitsch', 'e4 Nc6', ['nimzowitsch']],
  ['Apertura Española', 'e4 e5 Nf3 Nc6 Bb5', ['espanola', 'española', 'ruy lopez', 'ruy lópez']],
  ['Española, defensa Berlinesa', 'e4 e5 Nf3 Nc6 Bb5 Nf6', ['berlinesa', 'berlin', 'berlín']],
  ['Española, variante Abierta', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4', ['espanola abierta']],
  ['Española, ataque Marshall', 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5', ['marshall']],
  ['Apertura Italiana', 'e4 e5 Nf3 Nc6 Bc4', ['italiana']],
  ['Giuoco Piano', 'e4 e5 Nf3 Nc6 Bc4 Bc5', ['giuoco', 'piano']],
  ['Defensa de los dos caballos', 'e4 e5 Nf3 Nc6 Bc4 Nf6', ['dos caballos']],
  ['Gambito Evans', 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4', ['evans']],
  ['Apertura Escocesa', 'e4 e5 Nf3 Nc6 d4', ['escocesa']],
  ['Apertura de los cuatro caballos', 'e4 e5 Nf3 Nc6 Nc3 Nf6', ['cuatro caballos']],
  ['Apertura Vienesa', 'e4 e5 Nc3', ['vienesa', 'viena']],
  ['Gambito de Rey', 'e4 e5 f4', ['gambito de rey', 'gambito rey']],
  ['Defensa Rusa (Petrov)', 'e4 e5 Nf3 Nf6', ['petrov', 'petroff', 'rusa']],
  ['Defensa Philidor', 'e4 e5 Nf3 d6', ['philidor']],
  ['Gambito de Dama', 'd4 d5 c4', ['gambito de dama', 'gambito dama']],
  ['Gambito de Dama aceptado', 'd4 d5 c4 dxc4', ['gambito de dama aceptado', 'gda']],
  ['Gambito de Dama rehusado', 'd4 d5 c4 e6', ['gambito de dama rehusado', 'gdr']],
  ['Defensa Eslava', 'd4 d5 c4 c6', ['eslava', 'slava']],
  ['Defensa Semieslava', 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6', ['semieslava']],
  ['Defensa Tarrasch', 'd4 d5 c4 e6 Nc3 c5', ['tarrasch']],
  ['Sistema Londres', 'd4 d5 Nf3 Nf6 Bf4', ['londres', 'london']],
  ['Ataque Colle', 'd4 d5 Nf3 Nf6 e3', ['colle']],
  ['Defensa India de Rey', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6', ['india de rey', 'kid']],
  ['Defensa Grünfeld', 'd4 Nf6 c4 g6 Nc3 d5', ['grunfeld', 'grünfeld']],
  ['Defensa Nimzoindia', 'd4 Nf6 c4 e6 Nc3 Bb4', ['nimzoindia', 'nimzo']],
  ['Defensa India de Dama', 'd4 Nf6 c4 e6 Nf3 b6', ['india de dama']],
  ['Defensa Bogoindia', 'd4 Nf6 c4 e6 Nf3 Bb4+', ['bogoindia', 'bogo']],
  ['Apertura Catalana', 'd4 Nf6 c4 e6 g3', ['catalana']],
  ['Defensa India Antigua', 'd4 Nf6 c4 d6', ['india antigua']],
  ['Defensa Benoni', 'd4 Nf6 c4 c5 d5 e6', ['benoni']],
  ['Gambito Benko', 'd4 Nf6 c4 c5 d5 b5', ['benko', 'volga']],
  ['Defensa Budapest', 'd4 Nf6 c4 e5', ['budapest']],
  ['Ataque Trompowsky', 'd4 Nf6 Bg5', ['trompowsky', 'tromp']],
  ['Defensa Holandesa', 'd4 f5', ['holandesa']],
  ['Holandesa Leningrado', 'd4 f5 c4 Nf6 g3 g6', ['leningrado']],
  ['Inglesa Simétrica', 'c4 c5', ['inglesa simetrica']],
];

const salida = [], malas = [];
for (const [n, pgn, a] of G) {
  const j = pgn.split(' ');
  const ch = new Chess();
  let ok = true;
  for (const m of j) { try { ch.move(m); } catch { ok = false; break; } }
  if (!ok) { malas.push([n, 'jugada ilegal']); continue; }
  const v = tabla[epd(ch.fen())];
  if (!v) { malas.push([n, 'sin nombre en la tabla']); continue; }
  const i = v.indexOf('|');
  salida.push({ n, j, a, eco: v.slice(0, i), en: v.slice(i + 1) });
}
console.log('verificadas:', salida.length, 'de', G.length);
for (const [n, p] of malas) console.log('  DESCARTADA:', n, '--', p);
console.log('--- ES vs dataset ---');
for (const e of salida) console.log(String(e.eco).padEnd(4), e.n.padEnd(34), '<-', e.en);
fs.writeFileSync(SALIDA, JSON.stringify(salida));
console.log('bytes:', fs.statSync(SALIDA).size);
