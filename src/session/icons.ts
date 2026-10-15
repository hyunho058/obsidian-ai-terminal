import { addIcon } from 'obsidian';

/**
 * Custom pixel-art profile icons, registered with `addIcon` (drawn inside Obsidian's 0–100 viewBox).
 * Colours are set inline so Obsidian's `.svg-icon` stroke/fill rules don't flatten them.
 */
export const CLAUDE_ICON = 'ai-terminal-claude';
export const AGY_ICON = 'ai-terminal-agy';

interface Pixel {
  x: number;
  y: number;
  color: string;
}

/** One `<rect>` per pixel, scaled to `w`×`h` units and centred in the 100×100 box. */
function pixelSvg(pixels: readonly Pixel[], cols: number, rows: number, w: number, h: number): string {
  const ox = (100 - cols * w) / 2;
  const oy = (100 - rows * h) / 2;
  // Overlap each rect slightly so anti-aliasing leaves no hairline seams between neighbours.
  const rects = pixels.map(
    (p) =>
      `<rect x="${ox + p.x * w}" y="${oy + p.y * h}" width="${w + 0.3}" height="${h + 0.3}" style="fill:${p.color}"/>`,
  );
  return `<g style="stroke:none" shape-rendering="crispEdges">${rects.join('')}</g>`;
}

/** Clawd, the Claude Code mascot: an 18×5 grid of tall (1:2) half-block pixels. */
function claudeSvg(): string {
  const color = '#D97757';
  const rows: readonly string[] = [
    '...############...',
    '...##.######.##...',
    '.################.',
    '...############...',
    '....#.#....#.#....',
  ];
  const pixels: Pixel[] = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => c === '#' && pixels.push({ x, y, color })));
  return pixelSvg(pixels, 18, rows.length, 5.5, 11);
}

/** Antigravity "A": a 12×10 grid, orange at the apex fading to green/blue down the left leg and red/purple/blue down the right. */
function agySvg(): string {
  const rows: ReadonlyArray<ReadonlyArray<[number, string]>> = [
    [[5, '#F7A12C'], [6, '#F38B2A']],
    [[4, '#C9B83A'], [5, '#F5A030'], [6, '#F07E2E'], [7, '#EF6A3A']],
    [[3, '#8CC63F'], [4, '#A9C23C'], [5, '#F39A35'], [6, '#EE7A35'], [7, '#EC6142'], [8, '#E9524A']],
    [[3, '#7CC24A'], [4, '#8FB95A'], [5, '#E59A50'], [6, '#E57B4E'], [7, '#E0615A'], [8, '#D9506A']],
    [[2, '#6BBF59'], [3, '#69B87A'], [4, '#7FA6B0'], [5, '#8C8FC0'], [6, '#9C7FC0'], [7, '#A06FB8'], [8, '#9F6AB8'], [9, '#9A63B5']],
    [[2, '#5DB86B'], [3, '#57B08A'], [8, '#7C7FE0'], [9, '#8F71C9']],
    [[2, '#4DB08A'], [3, '#47A8A8'], [8, '#5B8FF0'], [9, '#6F80E0']],
    [[1, '#4AAF9A'], [2, '#3FA5C0'], [9, '#4A8FF2'], [10, '#5A86EE']],
    [[1, '#46B0B8'], [2, '#40A8D5'], [9, '#3F8EF5'], [10, '#4C88F0']],
    [[0, '#5EC3E8'], [1, '#4BB5E8'], [10, '#3E8CF5'], [11, '#3B82F6']],
  ];
  const pixels = rows.flatMap((row, y) => row.map(([x, color]) => ({ x, y, color })));
  return pixelSvg(pixels, 12, rows.length, 8, 8);
}

export function registerProfileIcons(): void {
  addIcon(CLAUDE_ICON, claudeSvg());
  addIcon(AGY_ICON, agySvg());
}
