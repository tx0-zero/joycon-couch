import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build');
fs.mkdirSync(OUT, { recursive: true });

// 1. macOS 原生 Swift HID 桥接编译
if (process.platform === 'darwin') {
  const src = path.join(ROOT, 'native', 'JoyConHelper.swift');
  const bin = path.join(OUT, 'JoyConHelper');
  if (!fs.existsSync(bin) || fs.statSync(src).mtimeMs > fs.statSync(bin).mtimeMs) {
    execFileSync(
      'xcrun',
      [
        'swiftc', '-O', '-swift-version', '5',
        '-target', `${process.arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos13.0`,
        src, '-o', bin,
        '-framework', 'Foundation', '-framework', 'IOKit', '-framework', 'CoreGraphics', '-framework', 'ApplicationServices',
      ],
      { stdio: 'inherit' },
    );
    console.log('✓ 已编译 macOS 原生 JoyConHelper');
  } else {
    console.log('✓ JoyConHelper 已是最新');
  }
}

// 2. 用 Node 原生或 esbuild（若存在）打包/转译 TS
const esbuildCandidates = [
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  '/Volumes/Mac-SSD/manus/outputs/yuxie/node_modules/.bin/esbuild',
];
const esbuildBin = esbuildCandidates.find((p) => fs.existsSync(p));
if (!esbuildBin) {
  console.error('未找到 esbuild，请先执行 npm install');
  process.exit(1);
}

execFileSync(
  esbuildBin,
  [
    path.join(ROOT, 'src', 'cli.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=node20',
    `--outfile=${path.join(OUT, 'cli.mjs')}`,
  ],
  { stdio: 'inherit' },
);
execFileSync(
  esbuildBin,
  [
    path.join(ROOT, 'src', 'test.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=node20',
    `--outfile=${path.join(OUT, 'test.mjs')}`,
  ],
  { stdio: 'inherit' },
);
console.log('✓ 构建完成：build/cli.mjs & build/test.mjs');
