"""Rangos ECO -> familia de apertura.

ES LA MISMA TABLA QUE `public/bloques.js`, y tiene que seguir siéndolo: la app
agrupa por estos bloques y el volcado escribe un fichero por bloque. Si se
tocan aquí y allí no, un bloque entero deja de encontrarse.

Que exista dos veces no es alegre, pero la alternativa —generar una desde la
otra— mete un paso de compilación entre "escribo" y "está desplegado" para
ahorrar veinte líneas que no cambian nunca.
"""

BLOQUES = [
    ('A00', 'A09', 'A0',  'Aperturas irregulares'),
    ('A10', 'A39', 'A1',  'Inglesa'),
    ('A40', 'A44', 'A4',  'Defensas irregulares contra 1.d4'),
    ('A45', 'A49', 'A45', 'Sistemas con 1.d4 Cf6'),
    ('A50', 'A79', 'A5',  'Benoni e India antigua'),
    ('A80', 'A99', 'A8',  'Holandesa'),
    ('B00', 'B09', 'B0',  'Alekhine, Pirc y Moderna'),
    ('B10', 'B19', 'B1',  'Caro-Kann'),
    ('B20', 'B99', 'B2',  'Siciliana'),
    ('C00', 'C19', 'C0',  'Francesa'),
    ('C20', 'C59', 'C2',  'Aperturas abiertas'),
    ('C60', 'C99', 'C6',  'Española'),
    ('D00', 'D05', 'D0',  'Sistemas con 1.d4 d5'),
    ('D06', 'D69', 'D1',  'Gambito de dama'),
    ('D70', 'D99', 'D7',  'Grünfeld'),
    ('E00', 'E09', 'E0',  'Catalana'),
    ('E10', 'E19', 'E1',  'India de dama'),
    ('E20', 'E59', 'E2',  'Nimzoindia'),
    ('E60', 'E99', 'E6',  'India de rey'),
]

CLAVES = [b for _, _, b, _ in BLOQUES]
NOMBRES = {b: n for _, _, b, n in BLOQUES}


def bloque_de(eco):
    """ECO -> clave del bloque, o None si no se puede clasificar."""
    e = str(eco or '').strip().upper()[:3]
    if len(e) != 3 or e[0] not in 'ABCDE' or not e[1:].isdigit():
        return None
    for ini, fin, clave, _ in BLOQUES:
        if ini <= e <= fin:
            return clave
    return None
