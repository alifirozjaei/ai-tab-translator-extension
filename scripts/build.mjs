import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateIcons } from './gen-icons.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, 'icons'), { recursive: true });

console.log('>>> Building extension pages (popup, settings, offscreen, audio-processor, service-worker)...');
execSync('npx vite build', { cwd: root, stdio: 'inherit' });

console.log('>>> Building content script...');
execSync('npx vite build --config vite.content.config.ts', { cwd: root, stdio: 'inherit' });

console.log('>>> Generating icons...');
await generateIcons(resolve(dist, 'icons'));

console.log('>>> Relocating page HTML and rewriting asset paths...');
for (const page of ['popup', 'settings', 'offscreen']) {
  const srcHtml = resolve(dist, 'src', page, 'index.html');
  const destDir = resolve(dist, page);
  mkdirSync(destDir, { recursive: true });
  let html = readFileSync(srcHtml, 'utf8');
  html = html.replaceAll('../../assets/', '../assets/');
  writeFileSync(resolve(destDir, 'index.html'), html);
}
rmSync(resolve(dist, 'src'), { recursive: true, force: true });

console.log('>>> Verifying constrained-context bundles have no Node globals...');
const flatBundles = readdirSync(dist).filter((f) => f.endsWith('.js'));
let leaked = false;
for (const file of flatBundles) {
  const text = readFileSync(resolve(dist, file), 'utf8');
  if (/\bprocess\.env\b/.test(text) || /\brequire\s*\(/.test(text)) {
    console.error(`  WARNING: ${file} contains Node globals (process.env / require)`);
    leaked = true;
  }
}
if (leaked) {
  throw new Error('Build produced bundles that depend on Node globals in browser contexts.');
}
console.log('  OK: no Node globals in flat bundles.');

console.log('>>> Copying manifest.json...');
cpSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));

console.log('>>> Done. Load "dist/" as an unpacked extension in chrome://extensions');
