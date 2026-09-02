import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateIcons } from './gen-icons.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = resolve(root, 'release');
const targets = new Set(['chrome', 'edge', 'firefox']);
const requested = process.argv[2] ?? 'chrome';
if (requested !== 'all' && !targets.has(requested)) throw new Error(`Unknown target: ${requested}`);

rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
for (const target of requested === 'all' ? targets : [requested]) await buildTarget(target);

async function buildTarget(target) {
  const outDir = resolve(release, target);
  mkdirSync(outDir, { recursive: true });
  const env = { ...process.env, BUILD_OUT_DIR: outDir };
  console.log(`>>> Building ${target} extension pages...`);
  execFileSync('npx', ['vite', 'build'], { cwd: root, env, stdio: 'inherit' });
  console.log(`>>> Building ${target} content script...`);
  execFileSync('npx', ['vite', 'build', '--config', 'vite.content.config.ts'], { cwd: root, env, stdio: 'inherit' });
  await generateIcons(resolve(outDir, 'icons'));
  for (const page of ['popup', 'settings', 'offscreen']) {
    const srcHtml = resolve(outDir, 'src', page, 'index.html');
    const destDir = resolve(outDir, page);
    mkdirSync(destDir, { recursive: true });
    const html = readFileSync(srcHtml, 'utf8').replaceAll('../../assets/', '../assets/');
    writeFileSync(resolve(destDir, 'index.html'), html);
  }
  rmSync(resolve(outDir, 'src'), { recursive: true, force: true });
  const manifest = target === 'chrome' ? 'manifest.json' : `manifest.${target}.json`;
  cpSync(resolve(root, manifest), resolve(outDir, 'manifest.json'));
  verify(outDir);
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const archive = resolve(release, `livedub-${target}-v${version}.zip`);
  execFileSync('zip', ['-qr', archive, '.'], { cwd: outDir });
  console.log(`>>> ${target} package: ${archive}`);
}

function verify(outDir) {
  for (const file of readdirSync(outDir).filter((name) => name.endsWith('.js'))) {
    const text = readFileSync(resolve(outDir, file), 'utf8');
    if (/\bprocess\.env\b/.test(text) || /\brequire\s*\(/.test(text)) throw new Error(`Node globals found in ${file}`);
  }
}
