"""Turn assets/icon.png (white canvas) into a transparent, edge-to-edge app icon."""

from PIL import Image, ImageDraw, ImageFilter

SRC = "assets/icon.png"

img = Image.open(SRC).convert("RGB")
w, h = img.size
px = img.load()


def is_canvas(p):
    r, g, b = p
    return r > 244 and g > 244 and b > 244


xs, ys = [], []
for y in range(0, h, 2):
    for x in range(0, w, 2):
        if not is_canvas(px[x, y]):
            xs.append(x)
            ys.append(y)
x0, x1 = min(xs), max(xs)
y0, y1 = min(ys), max(ys)
print("tile bbox:", (x0, y0, x1, y1), "size:", (x1 - x0 + 1, y1 - y0 + 1))

top_row = [x for x in range(x0, x1 + 1) if not is_canvas(px[x, y0])]
radius = top_row[0] - x0
print("measured corner radius:", radius)


def build_icon(inset: int, blur: float) -> Image.Image:
    """Crop the tile, mask it with a rounded rect (inset to drop the blended
    1px edge that the white canvas left behind) and pad to a square canvas."""
    tw, th = x1 - x0 + 1, y1 - y0 + 1
    scale = 4
    mask = Image.new("L", (tw * scale, th * scale), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (inset * scale, inset * scale, tw * scale - 1 - inset * scale, th * scale - 1 - inset * scale),
        radius=max(1, (radius - inset)) * scale,
        fill=255,
    )
    mask = mask.resize((tw, th), Image.LANCZOS).filter(ImageFilter.GaussianBlur(blur))

    tile = img.crop((x0, y0, x1 + 1, y1 + 1)).convert("RGBA")
    tile.putalpha(mask)

    side = max(tw, th)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(tile, ((side - tw) // 2, (side - th) // 2), tile)
    return canvas


icon = build_icon(inset=1, blur=0.5).resize((1024, 1024), Image.LANCZOS)
icon.save("resources/icon.png", optimize=True)
print("wrote resources/icon.png", icon.size)

icon.save(
    "resources/icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote resources/icon.ico")

icon.resize((256, 256), Image.LANCZOS).save("src/renderer/src/assets/icon.png", optimize=True)
print("wrote src/renderer/src/assets/icon.png")

# Preview on the app's dark shell colour + white, to check for a white halo.
for name, bg in (("dark", (15, 23, 41, 255)), ("light", (255, 255, 255, 255))):
    preview = Image.new("RGBA", (512, 512), bg)
    preview.alpha_composite(icon.resize((384, 384), Image.LANCZOS), (64, 64))
    preview.convert("RGB").save(f"icon-preview-{name}.png")
print("wrote previews")
