/**
 * Annotate a screenshot with rectangles around changed regions.
 *
 * The raw pixelmatch overlay is unreadable when a layout SHIFT moves whole
 * sections: old and new content get superimposed in red ("pixel soup").
 * Reviewers understand a plain AFTER image with a box around what moved far
 * better — the Before column already shows the old state for comparison.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const RED = [220, 38, 38, 255];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function putPx(img, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (img.width * y + x) << 2;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

/** Draw a rectangle border (not filled) with the given edge thickness. */
export function drawRect(img, { x, y, w, h }, thickness = 6, color = RED) {
  const x0 = clamp(x, 0, img.width - 1);
  const y0 = clamp(y, 0, img.height - 1);
  const x1 = clamp(x + w, 0, img.width - 1);
  const y1 = clamp(y + h, 0, img.height - 1);
  for (let t = 0; t < thickness; t++) {
    for (let xx = x0; xx <= x1; xx++) {
      putPx(img, xx, y0 + t, color); // top
      putPx(img, xx, y1 - t, color); // bottom
    }
    for (let yy = y0; yy <= y1; yy++) {
      putPx(img, x0 + t, yy, color); // left
      putPx(img, x1 - t, yy, color); // right
    }
  }
}

/**
 * Read `srcPath`, draw a padded border around each box, write to `destPath`.
 * Boxes are `{x, y, w, h}` (the image-diff bbox shape).
 */
export function annotatePng(srcPath, destPath, boxes, { thickness = 6, pad = 12, color = RED } = {}) {
  const img = PNG.sync.read(readFileSync(srcPath));
  for (const b of boxes) {
    if (!b) continue;
    drawRect(
      img,
      { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 },
      thickness,
      color,
    );
  }
  writeFileSync(destPath, PNG.sync.write(img));
}
