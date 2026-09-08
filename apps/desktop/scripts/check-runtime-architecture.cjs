const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Arch } = require('builder-util');

function windowsExecutableArchitecture(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows Node executable');
  const offset = bytes.readUInt32LE(60);
  if (offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550) throw new Error('Invalid Windows PE header');
  return { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(offset + 4)];
}

function checkRuntimeArchitecture(context) {
  if (context.electronPlatformName !== 'win32') return;
  const root = join(context.packager.projectDir, '.runtime');
  const expected = Arch[context.arch];
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  const actual = windowsExecutableArchitecture(join(root, 'node', 'node.exe'));
  if (actual !== expected || manifest.prosperoRuntime?.architecture !== expected) {
    throw new Error(`Windows ${expected} package requires matching Node and dependencies. Run scripts/package.ps1 -Architecture ${expected} -NodeExecutable <matching-node.exe> first.`);
  }
}

module.exports = checkRuntimeArchitecture;
module.exports.windowsExecutableArchitecture = windowsExecutableArchitecture;
