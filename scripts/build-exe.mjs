// Builds MultiClaude.exe: a single Windows executable with Node.js and the app inside,
// marked as a GUI program so double-clicking it opens no console window.
//
//   npm run build:exe            (works on Windows, macOS and Linux; downloads node.exe when not on Windows)
//
// Uses Node's Single Executable Applications feature: https://nodejs.org/api/single-executable-applications.html
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as ResEdit from 'resedit';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const cache = path.join(dist, 'cache');
const nodeVersion = process.versions.node; // the blob must be made by the same Node version it runs on
const out = path.join(dist, 'MultiClaude.exe');
fs.mkdirSync(cache, { recursive: true });

const step = (msg) => console.log(`\n› ${msg}`);

// 0. The app reports its version so a newer exe can replace an older running one
{
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const { VERSION } = await import(new URL('../src/version.js', import.meta.url));
  if (VERSION !== pkgVersion) throw new Error(`src/version.js (${VERSION}) and package.json (${pkgVersion}) disagree`);
}

// 1. Bundle everything (with the UI page inlined) into one CommonJS file
step('Bundling');
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'app-main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${nodeVersion.split('.')[0]}`,
  outfile: path.join(dist, 'app.cjs'),
  logLevel: 'warning',
  plugins: [{
    name: 'inline-web',
    setup(build) {
      build.onResolve({ filter: /web-asset\.js$/ }, () => ({ path: 'web-asset', namespace: 'inline-web' }));
      build.onLoad({ filter: /.*/, namespace: 'inline-web' }, () => ({
        contents: `const html = ${JSON.stringify(html)};\nexport function indexHtml() { return html; }`,
        loader: 'js',
      }));
    },
  }],
});

// 2. Make the SEA blob
step('Creating the single-executable blob');
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(dist, 'app.cjs'),
  output: path.join(dist, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. Get a Windows node.exe of the same version
step(`Getting node.exe v${nodeVersion} for Windows x64`);
let nodeExe;
if (process.platform === 'win32' && process.arch === 'x64') {
  nodeExe = process.execPath;
} else {
  const zipName = `node-v${nodeVersion}-win-x64.zip`;
  const zip = path.join(cache, zipName);
  nodeExe = path.join(cache, `node-v${nodeVersion}-win-x64`, 'node.exe');
  if (!fs.existsSync(nodeExe)) {
    if (!fs.existsSync(zip)) {
      const res = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${zipName}`);
      if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
    execFileSync('unzip', ['-o', '-q', zip, `node-v${nodeVersion}-win-x64/node.exe`, '-d', cache], { stdio: 'inherit' });
  }
}
fs.copyFileSync(nodeExe, out);
fs.chmodSync(out, 0o755);

// 4. Inject the blob
step('Injecting the app');
execFileSync(process.execPath, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  out, 'NODE_SEA_BLOB', path.join(dist, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

// 5. Our icon and name instead of Node's (this also drops node.exe's now-invalid signature)
step('Setting icon and version info');
{
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(out), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
  for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, iconFile.icons.map((i) => i.data));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const [maj, min, pat] = pkg.version.split('.').map(Number);
  for (const vi of ResEdit.Resource.VersionInfo.fromEntries(res.entries)) {
    for (const lang of vi.getAllLanguagesForStringValues()) {
      vi.setStringValues(lang, {
        FileDescription: 'MultiClaude',
        ProductName: 'MultiClaude',
        CompanyName: 'MultiClaude',
        InternalName: 'MultiClaude',
        OriginalFilename: 'MultiClaude.exe',
        LegalCopyright: 'MIT License',
        FileVersion: pkg.version,
        ProductVersion: pkg.version,
      });
    }
    vi.setFileVersion(maj, min, pat, 0);
    vi.setProductVersion(maj, min, pat, 0);
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(out, Buffer.from(exe.generate()));
  fs.chmodSync(out, 0o755);
}

// 6. Mark it as a Windows GUI program (subsystem 2) instead of a console one (3), so no black window appears
step('Switching to the Windows GUI subsystem');
const buf = fs.readFileSync(out);
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a PE file');
const subsystemOffset = pe + 24 + 68; // optional header + 68 (same for PE32 and PE32+)
buf.writeUInt16LE(2, subsystemOffset);
fs.writeFileSync(out, buf);

const mb = (fs.statSync(out).size / 1e6).toFixed(1);
console.log(`\n✔ Built ${path.relative(root, out)} (${mb} MB)`);
