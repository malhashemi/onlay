#!/bin/sh
# Make the page's film and poster from a master cut.
#
#   packages/site/scripts/film.sh <master.mp4> <poster.png>
#
# The film: H.264 at the master's size and frame rate, CRF 24, `veryslow`,
# tuned for flat screen content, with the index at the front (`faststart`) so
# it starts playing before it has all arrived. The sound is copied untouched.
# The 38-second cut goes from 9.5 MB to 4.1 MB at SSIM 0.998 against the
# master. The poster: 1600 px wide WebP.
#
# Afterwards set `FILM.seconds` in src/config.ts to the cut's length.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../src/media"
ffmpeg -hide_banner -loglevel error -y -i "$1" \
  -c:v libx264 -preset veryslow -crf 24 -pix_fmt yuv420p -profile:v high -tune animation \
  -movflags +faststart -c:a copy "$out/film.mp4"
cwebp -quiet -q 82 -resize 1600 0 "$2" -o "$out/film-poster.webp"
ls -l "$out"
