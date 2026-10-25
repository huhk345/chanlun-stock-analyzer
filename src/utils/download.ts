/**
 * 浏览器端文件下载工具。
 *
 * - CSV 统一带 UTF-8 BOM, 保证 Excel 双击打开中文表头不乱码;
 * - 单元格转义用 csvCell(), 文本加引号并把内部引号翻倍, 数字保持原样。
 */

/** CSV 单元格转义: 文本加引号并翻倍内部引号; 数字按原样输出 (不带千分位, 否则破坏列) */
export function csvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return `"${value.replace(/"/g, '""')}"`;
}

/** 下载 CSV (rows 为已转义的单元格) */
export function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const csv = rows.map((r) => r.join(',')).join('\n');
  triggerDownload(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }), filename);
}

/** 下载 JSON */
export function downloadJson(filename: string, data: unknown): void {
  triggerDownload(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' }),
    filename,
  );
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}