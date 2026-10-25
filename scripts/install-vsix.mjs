// Builds the extension and installs this exact version into VS Code, replacing whatever
// version is installed. Old .vsix files are removed first, so a leftover build is never
// picked up by mistake and nothing has to be uninstalled by hand.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = `${name}-${version}.vsix`;
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

for (const f of fs.readdirSync(root)) {
  if (f.endsWith('.vsix')) fs.rmSync(path.join(root, f));
}
run('node esbuild.mjs');
run(`npx vsce package --no-dependencies -o ${vsix}`);
try {
  run(`code --install-extension ${vsix} --force`);
} catch {
  console.error(`\nBuilt ${vsix}, but the \`code\` command failed. Put \`code\` on your PATH (in VS Code: Shell Command: Install 'code' command in PATH), or install ${vsix} from the Extensions view (… › Install from VSIX…).`);
  process.exit(1);
}
console.log(`\nInstalled ${name} ${version}. In VS Code, run Developer: Reload Window to load it.`);
