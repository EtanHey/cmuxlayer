import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assetPath = fileURLToPath(
  new URL("../assets/sidebars/fleet.swift", import.meta.url),
);
const home = process.env.HOME || homedir();
const outputPath = join(
  home,
  ".config",
  "cmux",
  "sidebars",
  "fleet-dev.swift",
);

mkdirSync(dirname(outputPath), { recursive: true });
copyFileSync(assetPath, outputPath);
process.stdout.write(
  `Installed fleet development sidebar fallback at ${outputPath}\n`,
);
