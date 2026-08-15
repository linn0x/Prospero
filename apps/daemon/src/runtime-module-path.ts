/**
 * Locate a sibling emitted JavaScript module when code is being exercised
 * through Vitest's TypeScript transform.  Production always takes the first
 * branch (the importing file and its sibling both live in `dist`); source
 * tests take the second branch after `tsc --build` has populated `dist`.
 *
 * Keeping Worker/process entry resolution here avoids silently attempting to
 * start a non-existent `src/*.js` file in the Windows-native acceptance
 * suite.  The fallback is deliberately relative to this module, never CWD.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function emittedSiblingPath(moduleUrl: string, fileName: string): string {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const sibling = path.join(directory, fileName);
  return existsSync(sibling) ? sibling : path.resolve(directory, "../dist", fileName);
}

export function emittedSiblingUrl(moduleUrl: string, fileName: string): URL {
  return pathToFileURL(emittedSiblingPath(moduleUrl, fileName));
}
