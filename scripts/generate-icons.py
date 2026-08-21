"""Generate PWA app icons."""
from PIL import Image, ImageDraw

def make_icon(size, path):
    img = Image.new('RGBA', (size, size), (59, 130, 246, 255))  # #3B82F6 blue
    draw = ImageDraw.Draw(img)
    m = size // 5
    w = max(2, size // 30)
    # Box outline
    draw.rectangle([m, m, size - m, size - m], outline='white', width=w)
    # Cross lines
    mid = size // 2
    draw.line([(m + w, mid), (size - m - w, mid)], fill='white', width=w)
    draw.line([(mid, m + w), (mid, size - m - w)], fill='white', width=w)
    # Rounded corners (mask with rounded rect)
    radius = size // 6
    circle_q = Image.new('RGBA', (radius * 2, radius * 2), (0, 0, 0, 0))
    draw2 = ImageDraw.Draw(circle_q)
    draw2.ellipse([0, 0, radius * 2, radius * 2], fill=(0, 0, 0, 255))
    mask = Image.new('L', (size, size), 255)
    mask.paste(0, (0, 0, radius, radius), circle_q.crop((0, 0, radius, radius)))
    mask.paste(0, (size - radius, 0, size, radius), circle_q.crop((radius, 0, radius * 2, radius)))
    mask.paste(0, (0, size - radius, radius, size), circle_q.crop((0, radius, radius, radius * 2)))
    mask.paste(0, (size - radius, size - radius, size, size), circle_q.crop((radius, radius, radius * 2, radius * 2)))
    img.putalpha(mask)
    img.save(path, 'PNG')
    print(f"Generated {path} ({size}x{size})")

make_icon(192, '/Users/luoping/Documents/workbuudy/inventory-app/public/icon-192.png')
make_icon(512, '/Users/luoping/Documents/workbuudy/inventory-app/public/icon-512.png')
make_icon(180, '/Users/luoping/Documents/workbuudy/inventory-app/public/apple-touch-icon.png')
