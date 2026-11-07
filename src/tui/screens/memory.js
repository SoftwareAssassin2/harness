// The memory screen (h): the project's Hindsight memories (ASS-201: moved from app.js;
// its rows, keys and confirm stay in src/tui/memory.js).
import { MEMORY_HEADERS, memoryRows, memoryHead, memoryKey, memoryAsking, memoryUseLines } from '../memory.js';
import { boxTable } from '../table.js';
import { below, headerLines, platform } from './frame.js';
import { move } from './shared.js';

// The memory screen's grid (ASS-62): one row per memory of the selected
// project's Hindsight, and the lines its body may take: what is left under the
// header and above the legend, less the memory use over it (ASS-147) and a
// blank line, the line over the table and the one under it.
function memoryLayout(state, { columns = 0, rows = Infinity, now = 0 }) {
  const bottom = below(state) + Math.max(1, platform(state, columns, now).length);
  const free = rows - headerLines(state, columns, now).length - bottom;
  const use = memoryUseLines(state);
  return { use, rows: memoryRows(state.memories[state.projects[state.project]?.id]?.items ?? []), bodyHeight: free - 7 - use.length };
}

export function view(state, size) {
  const memory = memoryLayout(state, size);
  return [
    ...memory.use,
    '',
    memoryHead(state),
    ...boxTable(MEMORY_HEADERS, memory.rows.length ? memory.rows : [['No memories']], {
      columns: size.columns, stretch: 0, height: memory.bodyHeight + 4, scroll: state.memoryScroll,
      selected: state.focus === 'memories' && memory.rows.length ? state.memorySelected : undefined,
    }),
    memoryAsking(state),
  ];
}

// Its keys: memory.js's memoryKey, the grid moved as the others are.
export function onKey(state, key, size, { step, sideways }) {
  if (state.focus === 'memories' && !sideways) {
    const next = memoryKey(state, key, (selected, scroll, by) => move(memoryLayout(state, size), selected, scroll, by));
    if (next !== state) return next;
  }
}
