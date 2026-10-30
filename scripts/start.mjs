#!/usr/bin/env node
/**
 * One-command dev startup: `pnpm start`.
 *
 * Brings up both halves of the app and keeps them in one process group:
 *   1. the Rust backtest engine (engine-rs) on :8901
 *   2. the Vite dev server (which proxies /api/rust to it)
 *
 * The Rust binary is built on demand — including when the sources are newer than
 * the binary — using either the system toolchain or the project-local one at
 * `engine-rs/.toolchain` (see README).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'engine-rs');
const engineBin = path.join(engineDir, 'target', 'release', 'chanlun-engine-rs');
const enginePort = process.env.ENGINE_PORT || '8901';

const log = (msg) => console.log(`\x1b[36m[start]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m[start]\x1b[0m ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Rust toolchain resolution
// ---------------------------------------------------------------------------

/** Project-local toolchain first, then whatever is on PATH. */
function rustEnv() {
  const localCargo = path.join(engineDir, '.toolchain', 'cargo', 'bin', 'cargo');
  if (existsSync(localCargo)) {
    return {
      cargo: localCargo,
      env: {
        ...process.env,
        CARGO_HOME: path.join(engineDir, '.toolchain', 'cargo'),
        RUSTUP_HOME: path.join(engineDir, '.toolchain', 'rustup'),
        PATH: `${path.join(engineDir, '.toolchain', 'cargo', 'bin')}:${process.env.PATH ?? ''}`,
      },
    };
  }
  const which = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (which.status === 0) {
    return { cargo: 'cargo', env: process.env };
  }
  return null;
}

/** Newest mtime under engine-rs/src plus the manifest. */
function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  const src = path.join(engineDir, 'src');
  if (existsSync(src)) walk(src);
  const manifest = path.join(engineDir, 'Cargo.toml');
  if (existsSync(manifest)) newest = Math.max(newest, statSync(manifest).mtimeMs);
  return newest;
}

function ensureEngineBinary() {
  const exists = existsSync(engineBin);
  const stale = exists && newestSourceMtime() > statSync(engineBin).mtimeMs;
  if (exists && !stale) return;

  const toolchain = rustEnv();
  if (!toolchain) {
    fail(
      '找不到 Rust 工具链。请先安装 Rust, 或在 engine-rs/.toolchain 放一份项目内工具链 (见 README)。',
    );
  }

  log(exists ? 'engine 源码有更新, 重新编译…' : '首次启动, 编译 Rust 引擎…');
  const build = spawnSync(toolchain.cargo, ['build', '--release'], {
    cwd: engineDir,
    env: toolchain.env,
    stdio: 'inherit',
  });
  if (build.status !== 0) fail('Rust 引擎编译失败。');
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const children = [];

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1', ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push({ name, child });

  const prefix = (line) => {
    const color = name === 'engine' ? '\x1b[33m' : '\x1b[35m';
    return `${color}${name.padEnd(6)}\x1b[0m │ ${line}`;
  };
  const pipe = (stream, out) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix(line)}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code !== 0) {
      console.error(prefix(`退出, code=${code}`));
      shutdown(code ?? 1);
    }
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

ensureEngineBinary();

// Reuse an engine that is already listening (common while iterating), but only
// if it really is ours — otherwise the proxy would silently point elsewhere.
async function engineAlreadyRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${enginePort}/api/rust/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.framework !== undefined;
  } catch {
    return false;
  }
}

if (await engineAlreadyRunning()) {
  log(`:${enginePort} 上已有引擎在运行, 直接复用`);
} else {
  run('engine', engineBin, ['--root', root, '--port', enginePort]);
}

const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) fail('找不到 vite, 请先执行 pnpm install。');
run('web', process.execPath, [viteBin], {
  env: { RUST_ENGINE_TARGET: `http://127.0.0.1:${enginePort}` },
});

log(`引擎 :${enginePort} · 前端 Vite 启动中 · Ctrl+C 一起停止`);
