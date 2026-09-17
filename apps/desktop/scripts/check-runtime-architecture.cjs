const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Arch } = require('builder-util');

function windowsExecutableArchitecture(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows Node executable');
  const offset = bytes.readUInt32LE(60);
  if (offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550) throw new Error('Invalid Windows PE header');
  return { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(offset + 4)];
}

function machoArchitecture(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 8) throw new Error('Invalid Mach-O executable');
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = bytes.readUInt32BE(4);
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * 20;
      const cpu = bytes.readUInt32BE(offset);
      if (cpu === 0x01000007) return 'x64';
      if (cpu === 0x0100000c) return 'arm64';
    }
    return undefined;
  }
  const little = bytes.readUInt32LE(0);
  if (little === 0xfeedfacf || little === 0xfeedface) {
    const cpu = bytes.readUInt32LE(4);
    if (cpu === 0x01000007) return 'x64';
    if (cpu === 0x0100000c) return 'arm64';
  }
  throw new Error('Invalid Mach-O header');
}

function checkRuntimeArchitecture(context) {
  const root = join(context.packager.projectDir, '.runtime');
  const expected = Arch[context.arch];
  if (context.electronPlatformName === 'darwin') {
    const rust = join(root, 'prosperod-rs');
    if (!existsSync(rust)) throw new Error('Rust daemon binary is missing from .runtime. Run scripts/prepare-runtime.mjs after cargo build --release -p prosperod-rs.');
    const actual = machoArchitecture(rust);
    if (actual !== expected) throw new Error(`macOS ${expected} package requires matching prosperod-rs. Build target/release/prosperod-rs for ${expected} first.`);
    if (!existsSync(join(root, 'install-rust-daemon-launchagent.sh'))) throw new Error('macOS runtime is missing the Rust daemon LaunchAgent installer.');
    return;
  }
  if (context.electronPlatformName !== 'win32') return;
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  const actual = windowsExecutableArchitecture(join(root, 'node', 'node.exe'));
  if (actual !== expected || manifest.prosperoRuntime?.architecture !== expected) {
    throw new Error(`Windows ${expected} package requires matching Node and dependencies. Run scripts/package.ps1 -Architecture ${expected} -NodeExecutable <matching-node.exe> first.`);
  }
  const rust = join(root, 'prosperod-rs.exe');
  if (!existsSync(rust)) throw new Error('Rust daemon binary is missing from .runtime. Run scripts/package.ps1 after cargo build --release -p prosperod-rs.');
  const rustArch = windowsExecutableArchitecture(rust);
  if (rustArch !== expected) throw new Error(`Windows ${expected} package requires matching prosperod-rs.exe. Build target/release/prosperod-rs.exe for ${expected} first.`);
}

module.exports = checkRuntimeArchitecture;
module.exports.windowsExecutableArchitecture = windowsExecutableArchitecture;
module.exports.machoArchitecture = machoArchitecture;
