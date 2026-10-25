// Bundles the extension and the Agent SDK's session readers into one CommonJS file,
// so the .vsix ships without node_modules and without the SDK's platform binary.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // The SDK is ESM and reads import.meta.url; give it the CommonJS equivalent.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  // Only query() spawns the platform binary, and the viewer never calls it.
  external: ['vscode', '@anthropic-ai/claude-agent-sdk-*'],
  logLevel: 'info',
};

const builds = [
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  // vscode-free modules, for the node:test suite.
  { ...shared, entryPoints: ['src/sessions.ts', 'src/render.ts', 'src/periods.ts'], outdir: 'dist/test-lib' },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
