// Turn record-demo.mjs's WebM into a shareable GIF. Requires ffmpeg.
// Usage: node scripts/make-gif.mjs <input.webm> [output.gif]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const input = process.argv[2];
const output = process.argv[3] ?? "docs/media/demo.gif";
if (!input) throw new Error("Usage: make-gif.mjs <input.webm> [output.gif]");
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-ss",
    "0.8",
    "-i",
    input,
    "-vf",
    "fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
    "-loop",
    "0",
    output,
  ],
  { stdio: "inherit" },
);
const size = fs.statSync(output).size;
if (size > 4_000_000)
  throw new Error(`${output} is ${size} bytes: over the 4 MB budget`);
process.stdout.write(`${output}: ${size} bytes\n`);
