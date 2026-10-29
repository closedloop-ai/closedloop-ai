# Seed Portraits

These eleven portraits use DiceBear's Lorelei style by Lisa Wischofsky.
Both `@dicebear/core` and `@dicebear/lorelei` are pinned to version 9.4.2.

The style's [versioned LICENSE](https://unpkg.com/@dicebear/lorelei@9.4.2/LICENSE)
licenses all design files under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Its non-design code is MIT licensed. The original artwork is
[Lorelei on Figma](https://www.figma.com/community/file/1198749693280469639).
Package metadata reports MIT for the code; the package LICENSE separately
states the CC0 dedication for the artwork.

`options.json` records fixed colors, hair, faces, glasses, beards and seeds.
The signed-in person's files are `acme-dev.svg` and `acme-dev.webp`, following the canonical
neutral handle, while its generation seed remains `jordanavery`.

To regenerate, install the two pinned packages in a disposable directory,
copy `generate.mjs` there and run it with this avatar directory as its only
argument. Generation reads `options.json` and writes the SVGs here. The
product reads committed files and never loads DiceBear or fetches artwork.

ISS-12406, Daveth's decision: serve the same portraits as 48 x 48 WebP data
URLs. The original SVGs and options remain unchanged as the licensed source.
The collaboration auth route sends `name`, `avatar` and `color` in `userInfo`;
Liveblocks limits that entire JSON object to 2048 UTF-8 bytes. The seed's route
regression test measures all eleven identities, including the longest color
spelling, without changing the production route. The existing SVG expectations
still check provenance and self-contained source art; only the served format
expectations change to WebP.

The largest image is 736 bytes, its complete data URL is 1007 bytes, and the
largest route-built `userInfo` is 1077 bytes, leaving 971 bytes below the limit.

Rasterize offline with Node 24.18.1 and sharp 0.35.5. Copy `rasterize.mjs` to
a disposable directory and install sharp there, keeping it out of the seed's
runtime dependencies:

```sh
mkdir -p /tmp/vibe-avatar-converter
cp apps/api/scripts/vibe-seed/core/avatars/rasterize.mjs /tmp/vibe-avatar-converter/
npm install --prefix /tmp/vibe-avatar-converter --ignore-scripts --save-exact sharp@0.35.5
node /tmp/vibe-avatar-converter/rasterize.mjs "$PWD/apps/api/scripts/vibe-seed/core/avatars"
```

Conversion renders the SVG at density 288, resizes to 48 x 48, and encodes
WebP at quality 80 and effort 6 without metadata. The committed copies were
generated on macOS arm64 with sharp 0.35.5, libvips 8.18.7, librsvg 2.63.2
and libwebp 1.6.0. Keep those native versions for byte-identical regeneration;
`sharp.versions` reports them. All eleven files were decoded to verify their
dimensions and compared visually with their unchanged SVG sources.

The compact data URLs are written through the existing seed helper to users,
GitHub connections and external comment authors. Web and Desktop consume those
values through their existing user/comment APIs. Vercel finalize adopts the
signed-in person's Clerk image URL into all three tables; the other seeded
people retain their committed portraits.
