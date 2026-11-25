#!/bin/sh
# Makes the icon files and the store's small tile of icons/ring.py's renders in
# the folder given: sh icons/build.sh <folder>. Needs ImageMagick, and the font
# Figtree Bold in FIGTREE.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$1"
glow() { magick $1-fire.png -background black -alpha remove -alpha off g0.png; magick \( g0.png -blur 0x5 -evaluate multiply .7 \) \( g0.png -blur 0x22 -evaluate multiply 1.5 \) -compose screen -composite g.png; magick $1.png \( +clone -alpha extract \) \( -clone 0 -alpha off g.png -compose screen -composite \) -delete 0 +swap -alpha off -compose CopyOpacity -composite $1c.png; }
glow L; glow M; cp S.png Sc.png; cp T.png Tc.png
# The store wants 96 px of artwork in a 128 px icon with clear edges.
magick Lc.png -trim +repage -filter Lanczos -resize 104x104 -unsharp 0x0.6+0.5 -background none -gravity center -extent 128x128 icon-128.png
magick Mc.png -trim +repage -filter Lanczos -resize 46x46 -unsharp 0x0.6+0.6 -background none -gravity center -extent 48x48 icon-48.png
magick Sc.png -trim +repage -filter Lanczos -resize 30x30 -modulate 90,125 -unsharp 0x0.5+0.6 -background none -gravity center -extent 32x32 a32.png
magick a32.png -alpha extract -morphology Dilate Disk:1 -evaluate multiply .55 m32.png
magick -size 32x32 xc:'#4a2c06' m32.png -alpha off -compose CopyOpacity -composite a32.png -compose over -composite icon-32.png
magick Tc.png -trim +repage -filter Lanczos -resize 15x15 -modulate 90,125 -unsharp 0x0.5+0.6 -background none -gravity center -extent 16x16 a16.png
magick a16.png -alpha extract -morphology Dilate Disk:1 -evaluate multiply .55 m16.png
magick -size 16x16 xc:'#4a2c06' m16.png -alpha off -compose CopyOpacity -composite a16.png -compose over -composite icon-16.png
magick -size 440x280 radial-gradient:'#4a2f1e'-'#17110e' \( Lc.png -trim +repage -resize x180 \) -gravity west -geometry +26+0 -composite -font "$FIGTREE" -pointsize 38 -weight 700 -fill '#F5C542' -gravity west -annotate +218+0 'One Search' -alpha off promo-small-440x280.png
cp icon-16.png icon-32.png icon-48.png icon-128.png "$root/icons/"
cp promo-small-440x280.png "$root/store/"
