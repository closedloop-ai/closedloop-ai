import { readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/** ISS-12406: offline conversion only; the seed reads committed portraits. */
const directory = process.argv[2];
if (!directory) {
  throw new Error("Pass the avatar directory containing the Lorelei SVGs");
}
if (sharp.versions.sharp !== "0.35.5") {
  throw new Error("Rasterization requires sharp 0.35.5; see README.md");
}

for (const file of readdirSync(directory).filter((name) =>
  name.endsWith(".svg")
)) {
  await sharp(join(directory, file), { density: 288 })
    .resize(48, 48)
    .webp({ quality: 80, effort: 6 })
    .toFile(join(directory, `${file.slice(0, -4)}.webp`));
}
