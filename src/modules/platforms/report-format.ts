/**
 * 報表的等寬表格排版。抽出來是因為現在有四層（GSC / GA4 / Bing / Clarity）要出在
 * 同一份週報裡，四份各自抄一份 padRight 的下場是欄寬規則慢慢漂，同一份報表裡的
 * 表格對不齊。
 *
 * 全形字算 2 欄寬是這裡唯一不顯而易見的事：不做的話中文表格必歪。
 */

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

export function padRight(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

export function padLeft(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(s))) + s;
}

export function formatTable(headers: string[], rows: string[][], alignRight: boolean[]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? '')))
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) =>
        alignRight[i] ? padLeft(c, widths[i] as number) : padRight(c, widths[i] as number)
      )
      .join('  ')
      .trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
}

export const num = (n: number): string => n.toLocaleString('en-US');
export const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
/** 排序／位置：0 代表「沒有資料」而不是「排第 0 名」，所以印破折號。 */
export const pos = (n: number): string => (n > 0 ? n.toFixed(1) : '—');
