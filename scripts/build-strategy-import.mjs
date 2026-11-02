#!/usr/bin/env node
/**
 * 从策略源码生成「导入用」的 JSON（面板里「导入策略」直接吃的那个文件）。
 *
 * 唯一真源是 src/strategies/*.js —— 这个脚本只是把它序列化出来，
 * 避免手抄 code 字段导致两边不一致。
 *
 * 用法: node scripts/build-strategy-import.mjs src/strategies/xxx.js [--prompt="..."]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadStrategy, root } from './lib/strategy-sandbox.mjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => a.endsWith('.js'));
if (!file) {
  console.error('用法: node scripts/build-strategy-import.mjs src/strategies/xxx.js [--prompt="..."]');
  process.exit(1);
}
const promptArg = argv.find((a) => a.startsWith('--prompt='));
const prompt = promptArg ? promptArg.slice('--prompt='.length) : null;

const abs = path.isAbsolute(file) ? file : path.join(root, file);
const strat = loadStrategy(abs);

const out = {
  strategies: [
    {
      id: strat.id,
      name: strat.name,
      description: strat.description || '',
      code: readFileSync(abs, 'utf8'),
      prompt: prompt || `${strat.name}：${(strat.description || '').slice(0, 120)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

const target = abs.replace(/\.js$/, '.import.json');
writeFileSync(target, JSON.stringify(out, null, 2));
console.log(`已写入 ${path.relative(root, target)}  (${strat.params?.length || 0} 个参数)`);
