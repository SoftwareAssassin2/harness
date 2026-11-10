// One dashboard at a time (ASS-338): a dashboard started while another runs
// — run-tui.pid under HARNESS_HOME names a live one, see single-instance.js —
// stops dead before it starts anything. It shows only MESSAGE, red, centred
// on the screen and again on every resize, handles no key but Ctrl-C, and
// Ctrl-C ends it with 1: not 75, so harness-cli/tui.sh does not start it again.

export const MESSAGE = 'The harness is running in another process. Only one harness can run at a time.';

// The message in lines of at most `columns`: whole when it fits, else each
// sentence from a line of its own, its words wrapped (a word longer than a
// line on a line of its own).
function wrap(text, columns) {
  if (text.length <= columns) return [text];
  return text.split(/(?<=\.) /).flatMap(sentence => words(sentence, columns));
}
function words(text, columns) {
  const lines = [];
  for (const word of text.split(' ')) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= columns) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

// refusal(columns, rows) — the screen cleared and the message drawn, each
// line centred across, the lines together centred down; red.
export function refusal(columns, rows) {
  const lines = wrap(MESSAGE, Math.max(1, columns));
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  return '\x1b[2J' + lines.map((line, i) =>
    `\x1b[${top + i + 1};${Math.max(0, Math.floor((columns - line.length) / 2)) + 1}H\x1b[31m${line}\x1b[0m`).join('');
}

// stopDead({ stdin, stdout }) — takes the terminal (alternate screen, cursor
// hidden, raw keys) and shows the refusal until Ctrl-C, which restores the
// terminal and exits with 1. Never settles: main.js awaits it, so nothing
// after it runs.
export function stopDead({ stdin, stdout }) {
  const draw = () => stdout.write(refusal(stdout.columns, stdout.rows));
  stdout.write('\x1b[?1049h\x1b[?25l');
  draw();
  stdout.on('resize', draw);
  stdin.setRawMode(true);
  stdin.on('data', data => {
    if (!data.includes(0x03)) return;
    stdout.write('\x1b[?25h\x1b[?1049l');
    process.exit(1);
  });
  stdin.resume();
  return new Promise(() => {});
}
