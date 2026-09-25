// The UI page. The .exe build swaps this module for one with the HTML inlined.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

export function indexHtml() {
  return fs.readFileSync(file);
}
