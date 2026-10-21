#!/usr/bin/env python3
"""
exportar_rivales.py — vuelca la base OTB/FIDE a los artefactos que consume la app.

Se ejecuta EN TU ORDENADOR, no en el servidor. La app nunca consulta esta base:
lee unos ficheros ya cocinados que viven en R2. Por eso puedes tener el PC
apagado y la pestaña Rival sigue funcionando con el ultimo volcado.

    python herramientas/exportar_rivales.py \\
        --partidas  "data/rivals.db" \\
                    "data/historico.db" \\
        --jugadores "data/rivals.db" \\
        --salida    "shards"

--------------------------------------------------------------------------
DE DONDE SALEN LAS PARTIDAS — Y POR QUE EL ORDEN IMPORTA

Hay una tabla `otb_games` en CADA base, y no son la misma:

    rivals.db      2.422.177 partidas, 2.323.800 con los dos ID FIDE (95 %)
                   y al dia: 239.310 partidas de 2026.
    historico.db  4.407.389 partidas, 1.228.001 con los dos ID FIDE (27 %)
                   y para muchos jugadores no pasa de 2025.

El primer volcado leyo `historico.db` —es la grande— y salio con la mitad de
partidas utiles y sin lo ultimo. Se noto pidiendo un jugador con torneos
recientes: las suyas se paraban en 2025.

Ahora se leen VARIAS bases en el orden que se den y se deduplica por `gkey`,
quedandose con la primera aparicion. Por eso `rivals.db` va primero: cuando la
misma partida esta en las dos, la que manda es la de la base al dia.

Salen dos cosas:

    jugadores/<n>.json.gz   partidas agrupadas por cubo de fide_id
    indice/<letra>.json.gz  nombre -> ficha, para el buscador

--------------------------------------------------------------------------
POR QUE CUBOS Y NO UN FICHERO POR JUGADOR

Un fichero por jugador seria lo ideal para consultar —una peticion, tres kilos—
pero son casi 50.000 objetos que subir y mantener sincronizados. Con cubos de
`fide_id % 2048` salen ~2.000 ficheros de unos 50 KB: se suben en un minuto,
se sincronizan en incremental sin pensar, y bajar 50 KB para consultar a un
jugador no se nota en un movil. Es el punto donde el coste de operar deja de
importar y el de consultar todavia no.

--------------------------------------------------------------------------
LO QUE SE TIRA A PROPOSITO

  · Las partidas sin NINGUN fide_id. Con uno de los dos basta —a ese jugador se
    le atribuye con certeza— pero sin ninguno no hay a quien colgarlas.

    Se estudio casarlas por nombre (apellido + inicial, que es como escribe
    TWIC) y se descarto con numeros: resuelve el 43 % de los lados, pero casi
    todo el volumen se lo llevan jugadores de elite que ya estan en el tope de
    400 y no ganan nada. Sobre seis espanoles de club sacados al azar del
    volcado —el perfil de rival que importa aqui— la ganancia fue 0, 0, 0, 12,
    0 y 0 partidas. El volcado habria pasado de 182 a ~270 MB y habria traido
    riesgo de atribuir partidas a quien no es, a cambio de una mediana de dos
    partidas por jugador. No compensa.
  · Las jugadas a partir de la 20. El cruce con tu repertorio no mira mas
    alla. Empezo en 12 y se quedaba corto: a esa altura muchas aperturas siguen
    en teoria conocida y el analisis cortaba justo donde empieza lo que hay que
    preparar. Subirlo engorda el volcado, y es un precio que si compensa.
  · Las fechas que no se dejan interpretar. `played_at` viene con formatos
    mezclados, meses desconocidos y algun ano a dos digitos.
"""

import argparse, datetime, gzip, json, os, re, sqlite3, sys, time, unicodedata
from collections import defaultdict

CUBOS   = 2048   # ficheros de partidas
PLY_MAX = 40     # 20 jugadas de cada
TOPE    = 400    # partidas por jugador, las mas recientes
SEP     = '\x1f'  # separa la fecha de la fila ya serializada


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)


def normalizar(nombre):
    """Sin acentos, en minusculas y con los apellidos primero tal cual vienen.
    Es la forma en la que se busca, no la que se ensena."""
    s = unicodedata.normalize('NFD', nombre or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    # Los espacios se aplastan a uno. 'Zemler Hoppe, Jana' traia la coma Y el
    # espacio de detras, y salia con dos: quien tecleaba 'zemler hoppe jana' con
    # uno no encontraba nada.
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()


def fecha(v):
    """A YYYY-MM-DD cuando se puede, a YYYY-MM o YYYY si falta lo demas, si no None.

    El rango real de la base va de '1749-??-??' a '31-12-29': hay ISO, hay
    formatos con interrogantes y hay anos a dos digitos. Ordenar por este
    campo sin limpiarlo da listas de "partidas recientes" que no lo son.

    Hasta la Fase 31 se cortaba en el MES. En la pestana Rival eso deja dos
    torneos del mismo mes como una sola pila de partidas sin forma de
    separarlas; con el dia (y el torneo, ver `torneo()`) se distinguen."""
    v = (v or '').strip()
    m = re.match(r'^(\d{4})[.\-/](\d{2}|\?\?)(?:[.\-/](\d{2}|\?\?))?', v)
    if m:
        ano, mes, dia = m.group(1), m.group(2), m.group(3)
        if mes == '??' or not 1 <= int(mes) <= 12:
            return ano
        if dia and dia != '??' and 1 <= int(dia) <= 31:
            return f'{ano}-{mes}-{dia}'
        return f'{ano}-{mes}'
    m = re.match(r'^(\d{4})', v)
    return m.group(1) if m else None


# Lo que algunas bases escriben en Event y no es el nombre de ningun torneo.
EVENTO_VACIO = {'', '?', '-', '*', 'casual game', 'playzone game', 'live chess',
                'rated game', 'casual', 'game', 'unknown', 'unknown event'}
# «Round 4: Fulano - Mengano»: las retransmisiones viejas de Lichess guardan la
# ronda y la pareja en Event y el torneo en ningun sitio.
SOLO_RONDA = re.compile(r'^(?:round|ronda|runde|rd\.?)\s*\d+[^:]{0,20}:', re.I)
# «Stavanger Chess Challenge – Round 1: Fulano - Mengano»: el torneo va delante.
CON_RONDA = re.compile(r'^(.{3,}?)\s*[–—-]\s*(?:round|ronda|runde)\s*\d+[^:]{0,20}:', re.I)
BROADCAST = re.compile(r'lichess\.org/broadcast/([a-z0-9-]+)/', re.I)
TOPE_TORNEO = 70


def torneo(evento, sitio):
    """El nombre del torneo, limpio y corto, o None.

    Va en cada fila y no en una tabla aparte por jugador: dentro de un mismo
    jugador el nombre se repite ronda tras ronda y gzip se lo come casi entero.
    """
    e = ''.join(c for c in (evento or '')
                if unicodedata.category(c) not in ('So', 'Cs', 'Mn', 'Cc'))
    e = re.sub(r'\s+', ' ', e).strip(' -–—·|')
    m = CON_RONDA.match(e)
    if m:
        e = m.group(1).strip()
    elif SOLO_RONDA.match(e):
        e = ''
    # «1», «2026», «R3»: sin tres letras no es un nombre que ayude a nadie.
    if e.lower() in EVENTO_VACIO or sum(c.isalpha() for c in e) < 3:
        e = ''
    if not e:
        # Ultimo recurso: el slug de la retransmision, que si lleva el torneo.
        m = BROADCAST.search(sitio or '')
        slug = m.group(1).replace('-', ' ').strip() if m else ''
        if sum(c.isalpha() for c in slug) >= 4:
            e = re.sub(r'\s+', ' ', slug)
            e = e[0].upper() + e[1:]
    if len(e) > TOPE_TORNEO:
        e = e[:TOPE_TORNEO - 1].rstrip() + '…'
    return e or None


def valido(fid):
    return fid and fid.strip().isdigit() and 1000 <= int(fid) <= 99_999_999


SOLO_DIGITOS = re.compile(r'\D')


def huella(wf, bf, cuando, res, moves):
    """Identidad de una partida por su contenido, no por la id de su base.

    La fecha se reduce a digitos porque las bases la escriben de formas
    distintas ('2026-04-06' y '2026.04.06' son el mismo dia), y las jugadas
    entran solo por su NUMERO: la misma partida puede venir en SAN en una base
    y en algebraica larga en la otra, y comparando el texto no casaria.
    """
    return (f'{wf or ""}|{bf or ""}|{SOLO_DIGITOS.sub("", cuando or "")}'
            f'|{res or ""}|{len(moves.split())}')


def _dia(f):
    try:
        return datetime.date.fromisoformat(f) if f and len(f) == 10 else None
    except ValueError:
        return None


def sin_repetidas(ps, dias=3):
    """Quita la MISMA partida que llega dos veces con la fecha movida (17 oct 2026).

    `huella()` deduplica por jugadores + dia + resultado + numero de jugadas,
    y se le escapaban copias con un dia de diferencia: la retransmision de
    Lichess fecha en UTC y TWIC con la fecha del torneo, o una base escribe
    «Girel,Joseph» y otra «Girel, Joseph». Medido en 1/8 de los cubos: 693 de
    428.687 filas (0,16 %), casi todas de 2026, que es justo lo que se mira.

    Aqui, ya por jugador, una partida es repetida si coincide con otra en
    color, jugadas (las 20 primeras de cada, que es lo que se guarda),
    resultado y contrario (sin acentos, comas ni orden de palabras), y las
    fechas estan a `dias` o menos. Con solo el mes, basta el mismo mes. Dos
    partidas distintas contra el mismo rival, con el mismo color, el mismo
    resultado y las mismas cuarenta medias jugadas en la misma semana no se
    dan en la practica.

    `ps` son las cadenas 'fecha\x1ffila' ordenadas de mas reciente a mas vieja;
    se queda la primera que aparece."""
    vistas, fuera, quitadas = {}, [], 0
    for p in ps:
        f, fila = p.split(SEP, 1)
        x = json.loads(fila)
        clave = (x[0], x[2], x[3], ' '.join(sorted(normalizar(x[5] or '').split())))
        d = _dia(f)
        antes = vistas.setdefault(clave, [])
        rep = False
        for od, of in antes:
            if d and od:
                rep = abs((d - od).days) <= dias
            else:
                rep = bool(f) and f[:7] == of[:7]
            if rep:
                break
        if rep:
            quitadas += 1
            continue
        antes.append((d, f))
        fuera.append(p)
    return fuera, quitadas


def fichas_fide(jugadores_db):
    log('Leyendo el censo FIDE…')
    fichas = {}
    con = sqlite3.connect(f'file:{jugadores_db}?mode=ro', uri=True)
    for fid, nombre, fed, titulo, elo in con.execute(
            'SELECT fideid, name, fed, title, elo_std FROM fide_players'):
        fichas[str(fid)] = (nombre, fed, titulo, elo)
    con.close()
    log(f'  {len(fichas):,} fichas')
    return fichas


# AL MENOS UNO de los dos ID, no los dos.
#
# Estaba pidiendo los dos, y eso tiraba ~27.000 partidas en las que uno de los
# jugadores SI esta identificado. Su ID esta en el registro: atribuirle la
# partida es tan seguro como cualquier otra, y quien no tenga ID se queda como
# lo que ya era, un nombre suelto en la ficha del rival. No hay ninguna
# conjetura de por medio.
NO_ESTANDAR = re.compile(r'freestyle|chess ?960|fischer ?random|\b960\b', re.I)

SQL = """SELECT gkey, white_fide, black_fide, white, black, white_elo, black_elo,
                result, eco, played_at, moves, event, site
         FROM otb_games
         WHERE (white_fide IS NOT NULL AND white_fide <> '')
            OR (black_fide IS NOT NULL AND black_fide <> '')"""


def pasada(bases, fichas, salida, desde, hasta):
    """Procesa solo los cubos [desde, hasta) y deja sus ficheros escritos.

    Por pasadas y no de una vez porque cargar los 2.048 cubos a la vez son
    millones de partidas vivas en memoria: varios gigas con la sobrecarga de
    Python, y la maquina se queda sin aire justo cuando ya ha leido toda la
    base. Releer las tablas en cada pasada cuesta unos minutos y ahorra ese
    problema entero.

    Cada partida se guarda ya serializada como una sola cadena, con su fecha
    delante para poder ordenarla. Guardarla como lista de siete campos
    multiplica por ocho el numero de objetos, y ahi es donde se va la memoria.

    Las bases se leen EN ORDEN y se deduplica POR CONTENIDO: la primera
    aparicion gana. El conjunto de claves solo guarda las partidas que caen en
    el tramo de cubos de esta pasada, que es lo que lo mantiene manejable.

    Por contenido y no por `gkey`, que es lo que hacia antes y no funcionaba:
    cada base calcula su propia gkey, asi que la MISMA partida aparecia con dos
    identificadores distintos y entraba dos veces. Se comio el 36 % del volcado
    —una de cada tres partidas era una copia— y se veia en la pestana Rival como
    partidas repetidas.

    La clave es jugadores + dia + resultado + numero de jugadas, y a proposito
    NO incluye las jugadas: hay partidas que vienen en algebraica larga en una
    base y en SAN en la otra, y comparando texto se colarian igual. Dos partidas
    distintas entre los mismos dos jugadores, el mismo dia, con el mismo
    resultado y exactamente la misma longitud no existen en la practica.
    """
    cubos = defaultdict(lambda: defaultdict(list))
    vistas = set()
    leidas = usadas = repes = fuera960 = 0

    for base in bases:
        con = sqlite3.connect(f'file:{base}?mode=ro', uri=True)
        for (gkey, wf, bf, w, b, we, be, res, eco, cuando, moves, evento, sitio) in con.execute(SQL):
            leidas += 1
            okw, okb = valido(wf), valido(bf)
            if not (okw or okb) or not moves:
                continue
            # Freestyle y Chess960 salen en las mismas bases y sus jugadas son
            # ilegales desde la posicion inicial de siempre: no se pueden cruzar
            # contra un repertorio y solo ocupan sitio en el tope de cada
            # jugador. Se filtran por el nombre del torneo, que es lo unico que
            # se puede mirar sin un motor de ajedrez aqui dentro; las que se
            # escapen las caza la app al reproducirlas.
            if NO_ESTANDAR.search(evento or ''):
                fuera960 += 1
                continue

            # Cada lado entra solo si SU ID es valido. Sin la comprobacion por
            # separado, un `int(None)` revienta en cuanto falta uno.
            dentro_w = okw and desde <= int(wf) % CUBOS < hasta
            dentro_b = okb and desde <= int(bf) % CUBOS < hasta
            if not (dentro_w or dentro_b):
                continue

            # La deduplicacion va DESPUES del filtro de cubos: guardar la clave
            # de una partida que esta pasada no va a escribir no sirve de nada y
            # multiplica por dos la memoria del conjunto.
            clave = huella(wf, bf, cuando, res, moves)
            if clave in vistas:
                repes += 1
                continue
            vistas.add(clave)
            usadas += 1

            jugadas = ' '.join(moves.split()[:PLY_MAX])
            f = fecha(cuando) or ''
            # Octavo campo, desde la Fase 31: el torneo. Solo se escribe si lo
            # hay, y la app lee `x[7] || null`, asi que los cubos viejos (de
            # siete campos) siguen valiendo tal cual.
            t = torneo(evento, sitio)
            extra = [t] if t else []
            # La misma partida entra en los dos jugadores, cada uno con su color
            # y su rival: quien consulta a uno no tiene que buscar en el otro.
            if dentro_w:
                fila = json.dumps(['w', eco, jugadas, res, f or None, b, be or 0] + extra,
                                  ensure_ascii=False, separators=(',', ':'))
                cubos[int(wf) % CUBOS][wf].append(f + SEP + fila)
            if dentro_b:
                fila = json.dumps(['b', eco, jugadas, res, f or None, w, we or 0] + extra,
                                  ensure_ascii=False, separators=(',', ':'))
                cubos[int(bf) % CUBOS][bf].append(f + SEP + fila)
        con.close()

    del vistas

    resumen = {}
    total_j = bytes_j = movidas = 0
    for c in range(desde, hasta):
        jugadores = cubos.get(c)
        if not jugadores:
            continue
        trozos = []
        for fid, ps in jugadores.items():
            # Las mas recientes primero y con tope: un jugador con 4.000
            # partidas no aporta cuatro mil veces mas informacion que uno con
            # cuatrocientas, y si engorda el cubo para todos los demas.
            ps.sort(reverse=True)
            ps, q = sin_repetidas(ps)
            movidas += q
            ps = ps[:TOPE]
            nombre, fed, titulo, elo = fichas.get(fid, (None, None, None, None))
            cab = json.dumps({'n': nombre, 'fed': fed, 't': titulo, 'e': elo},
                             ensure_ascii=False, separators=(',', ':'))[:-1]
            juegos = ','.join(p.split(SEP, 1)[1] for p in ps)
            trozos.append(f'"{fid}":{cab},"g":[{juegos}]}}')
            resumen[fid] = len(ps)
            total_j += 1

        ruta = os.path.join(salida, 'jugadores', f'{c}.json.gz')
        with gzip.open(ruta, 'wt', encoding='utf-8', compresslevel=6) as fh:
            fh.write('{' + ','.join(trozos) + '}')
        bytes_j += os.path.getsize(ruta)

    log(f'  cubos {desde}-{hasta - 1}: {total_j:,} jugadores, '
        f'{bytes_j / 2**20:.1f} MB, de {usadas:,} partidas usadas '
        f'({repes:,} repetidas, {movidas:,} repetidas con la fecha movida '
        f'y {fuera960:,} de 960 descartadas)')
    return resumen, leidas, usadas, bytes_j


def indice(fichas, salida, resumen):
    """Nombre normalizado -> ficha, solo de quien tiene partidas.

    El censo entero son 1,9 millones de fichas y 38 de cada 39 no tienen
    ninguna partida: incluirlas seria hacer que el buscador se descargue megas
    de gente sobre la que no hay nada que ensenar.
    """
    log('Escribiendo el indice de nombres…')
    letras = defaultdict(list)
    for fid, n in resumen.items():
        nombre, fed, titulo, elo = fichas.get(fid, (None, None, None, None))
        if not nombre:
            continue
        norm = normalizar(nombre)
        if not norm:
            continue
        letra = norm[0] if norm[0].isalpha() else '0'
        letras[letra].append([norm, fid, fed, elo, titulo, n])

    bytes_i = 0
    for letra, filas in letras.items():
        filas.sort(key=lambda f: -f[5])   # los de mas partidas primero
        ruta = os.path.join(salida, 'indice', f'{letra}.json.gz')
        with gzip.open(ruta, 'wt', encoding='utf-8', compresslevel=6) as fh:
            json.dump(filas, fh, ensure_ascii=False, separators=(',', ':'))
        bytes_i += os.path.getsize(ruta)
    log(f'  {len(letras)} letras en {bytes_i / 2**10:.0f} KB')
    return sorted(letras), bytes_i


def exportar(bases, jugadores_db, salida, pasadas=6):
    os.makedirs(os.path.join(salida, 'jugadores'), exist_ok=True)
    os.makedirs(os.path.join(salida, 'indice'), exist_ok=True)

    for b in bases:
        if not os.path.exists(b):
            raise SystemExit(f'No existe la base {b}')
    log('Bases de partidas, en orden de preferencia:')
    for b in bases:
        log(f'  {b}')

    fichas = fichas_fide(jugadores_db)
    resumen, leidas, usadas, bytes_j = {}, 0, 0, 0
    paso = CUBOS // pasadas
    for k in range(pasadas):
        log(f'Pasada {k + 1} de {pasadas}…')
        hasta = (k + 1) * paso if k < pasadas - 1 else CUBOS
        r, l, u, b = pasada(bases, fichas, salida, k * paso, hasta)
        resumen.update(r)
        # `leidas` es igual en todas las pasadas —cada una relee las tablas
        # enteras— asi que se queda con la ultima y no se suma. `usadas` SI se
        # suma... y no se puede: una partida cuyos dos jugadores caen en
        # pasadas distintas se cuenta en las dos. El numero bueno se saca al
        # final de `resumen`, que es el unico sitio donde cada jugador aparece
        # una vez.
        leidas, bytes_j = l, bytes_j + b

    letras, bytes_i = indice(fichas, salida, resumen)

    # `filas` = partidas guardadas contando una vez por jugador identificado.
    # No se publica una cifra de "partidas distintas" porque ya no se puede
    # deducir dividiendo entre dos: desde que se aceptan partidas con un solo ID,
    # unas aportan dos filas y otras una. Inventar el numero seria peor que no
    # darlo. (La version anterior publicaba el recuento de la ULTIMA pasada como
    # si fuera el total, y salia la mitad de lo real.)
    filas = sum(resumen.values())
    meta = {
        'generado': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'cubos': CUBOS, 'ply_max': PLY_MAX, 'tope_partidas': TOPE,
        'bases': [os.path.basename(b) for b in bases],
        'jugadores': len(resumen),
        'filas': filas,                    # partidas x jugador identificado
        'candidatas': leidas,              # filas con al menos un ID en las bases
        'letras': letras,
    }
    # El apartado `censo` lo escribe exportar_censo.py. Si este script lo
    # pisara, la app dejaria de pedir el censo hasta volver a pasar aquel: se
    # conserva el que hubiera.
    previo = os.path.join(salida, 'meta.json')
    if os.path.exists(previo):
        try:
            with open(previo, encoding='utf-8') as fh:
                viejo = json.load(fh)
            if 'censo' in viejo:
                meta['censo'] = viejo['censo']
        except (OSError, ValueError):
            pass
    with open(os.path.join(salida, 'meta.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    # Y comprimido, porque el proxy autenticado de la app solo sirve .json.gz:
    # abrir la puerta a otras extensiones por un fichero de 300 bytes no compensa.
    with gzip.open(os.path.join(salida, 'meta.json.gz'), 'wt', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False)

    # El censo se calcula CONTRA este indice (entra quien no tiene partidas), asi
    # que queda viejo en cuanto se vuelca: hay que pasar exportar_censo.py
    # DESPUES, siempre. Y si el meta no traia `censo`, la app ni lo consulta y
    # todo jugador sin partidas -casi todos los inactivos- desaparece del buscador.
    if 'censo' not in meta:
        log('*** AVISO: meta.json SIN apartado `censo`: la app no buscara a nadie '
            'sin partidas. Pasa ahora exportar_censo.py y sube meta.json.gz. ***')
    else:
        log('Recuerda: pasa exportar_censo.py ahora (el censo depende de este indice).')

    log(f'Listo. {len(resumen):,} jugadores y {filas:,} filas '
        f'(una por jugador identificado) en {(bytes_j + bytes_i) / 2**20:.0f} MB, '
        f'en {salida}')
    return meta


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--partidas', required=True, nargs='+',
                    help='una o mas bases con tabla otb_games, de mas fiable a menos; '
                         'se deduplica por gkey y gana la primera')
    ap.add_argument('--jugadores', required=True, help='rivals.db (tabla fide_players)')
    ap.add_argument('--salida', required=True, help='carpeta donde dejar los artefactos')
    ap.add_argument('--pasadas', type=int, default=6,
                    help='en cuantas tandas se procesan los cubos (mas tandas, menos memoria)')
    a = ap.parse_args()
    try:
        exportar(a.partidas, a.jugadores, a.salida, a.pasadas)
    except KeyboardInterrupt:
        log('Interrumpido.')
        sys.exit(1)
