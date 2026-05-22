import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function listTypeScriptFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (statSync(fullPath).isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("dependency boundaries", () => {
  it("keeps services independent from command-layer imports", () => {
    const serviceDir = resolve(process.cwd(), "src/services");
    const files = listTypeScriptFiles(serviceDir);
    const violatingFiles: Array<{ file: string; imports: string[] }> = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const imports = [...content.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((match) => match[1] ?? "")
        .filter((specifier) => /(^|\/)commands\//.test(specifier));
      const dynamicImports = [...content.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)]
        .map((match) => match[1] ?? "")
        .filter((specifier) => /(^|\/)commands\//.test(specifier));
      const allImports = [...new Set([...imports, ...dynamicImports])];
      if (allImports.length > 0) {
        violatingFiles.push({
          file,
          imports: allImports,
        });
      }
    }

    expect(violatingFiles).toEqual([]);
  });
});
