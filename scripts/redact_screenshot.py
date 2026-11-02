"""Redact the value column of the env-vars screenshot before publishing it."""
from PIL import Image, ImageFilter

src = r"docs/screenshots/env-vars.png"
img = Image.open(src).convert("RGB")

# value column of the table (name column ends ~495, type badge starts ~1165)
box = (497, 168, 1160, 668)
crop = img.crop(box)
small = crop.resize((max(1, crop.width // 14), max(1, crop.height // 14)), Image.BILINEAR)
blurred = small.resize(crop.size, Image.NEAREST).filter(ImageFilter.GaussianBlur(3))
img.paste(blurred, box)
img.save(src, optimize=True)
print("redacted", src, img.size)
