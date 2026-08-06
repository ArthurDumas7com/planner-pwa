"""Генерация PNG-иконок приложения без внешних библиотек.

Рисуем ту же композицию, что в icon.svg: скруглённый тёмный квадрат и четыре плитки
(две сплошные зелёные = стратегия, две пунктирные оранжевые = гибкие задачи).
PNG собирается вручную: zlib + struct, поэтому Pillow не нужен.
"""
import struct
import zlib

BG = (22, 24, 26)          # Smooth Black
GREEN = (10, 125, 85)      # Bench Green
ORANGE = (217, 117, 40)    # Matte Orange


def rounded_rect_mask(size, radius):
    """Маска скруглённого квадрата: True — внутри фигуры."""
    mask = [[True] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            cx = min(x, size - 1 - x)
            cy = min(y, size - 1 - y)
            if cx < radius and cy < radius:
                dx = radius - cx
                dy = radius - cy
                mask[y][x] = dx * dx + dy * dy <= radius * radius
    return mask


def draw(size):
    px = [[BG for _ in range(size)] for _ in range(size)]
    mask = rounded_rect_mask(size, int(size * 0.22))

    # четыре плитки 2x2 с отступами
    pad = int(size * 0.22)
    gap = int(size * 0.06)
    tile = (size - pad * 2 - gap) // 2
    tiles = [
        (pad, pad, GREEN, True),                       # слева сверху — сплошная
        (pad + tile + gap, pad, ORANGE, False),        # справа сверху — «пунктирная»
        (pad, pad + tile + gap, ORANGE, False),        # слева снизу
        (pad + tile + gap, pad + tile + gap, GREEN, True),
    ]
    border = max(2, size // 40)
    dash = max(2, size // 24)
    for tx, ty, color, solid in tiles:
        for y in range(ty, ty + tile):
            for x in range(tx, tx + tile):
                edge = (x - tx < border or tx + tile - x <= border
                        or y - ty < border or ty + tile - y <= border)
                if solid:
                    px[y][x] = color
                elif edge:
                    # пунктир: рисуем через сегмент
                    along = (x - tx) if (y - ty < border or ty + tile - y <= border) else (y - ty)
                    if (along // dash) % 2 == 0:
                        px[y][x] = color

    raw = b''
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            r, g, b = px[y][x] if mask[y][x] else (0, 0, 0)
            a = 255 if mask[y][x] else 0
            raw += bytes((r, g, b, a))
    return raw


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))


def write_png(path, size):
    raw = draw(size)
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)   # 8 бит, RGBA
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header)
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}: {size}x{size}, {len(png)} байт')


if __name__ == '__main__':
    write_png('icon-192.png', 192)
    write_png('icon-512.png', 512)
    write_png('apple-touch-icon.png', 180)
