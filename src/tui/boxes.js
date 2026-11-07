// A row of boxes side by side: each as wide as its widest line, all as tall as
// the tallest, four columns apart, the row centered in `columns`.
import { visible, pad } from './text.js';

// boxRow([[line, …], …], columns) — the row's lines, or none without boxes.
export function boxRow(boxes, columns) {
  if (!boxes.length) return [];
  const height = Math.max(...boxes.map(box => box.length));
  const widths = boxes.map(box => Math.max(...box.map(visible)));
  const lines = [
    widths.map(w => `┌${'─'.repeat(w + 2)}┐`),
    ...Array.from({ length: height }, (_, i) => boxes.map((box, n) => `│ ${pad(box[i] ?? '', widths[n])} │`)),
    widths.map(w => `└${'─'.repeat(w + 2)}┘`),
  ].map(parts => parts.join('    '));
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - visible(lines[0])) / 2)));
  return lines.map(line => indent + line);
}
