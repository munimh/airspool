// tsc keeps ".ts" in relative imports inside .d.ts files. Point them at the
// ".js" files that sit next to the declarations, so every TypeScript version
// resolves them.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist", import.meta.url));
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );

for (const file of walk(root).filter((f) => f.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8");
  const fixed = text.replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
  if (fixed !== text) writeFileSync(file, fixed);
}
