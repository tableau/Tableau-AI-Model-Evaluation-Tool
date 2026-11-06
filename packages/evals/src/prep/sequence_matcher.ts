/**
 * Python `difflib.SequenceMatcher(None, a, b, autojunk=False)`, the parts the
 * Prep scoring uses: `get_matching_blocks()` and `get_opcodes()`. With no junk
 * function and autojunk off, every element of `b` is indexed, so the blocks
 * equal Python's exactly (same longest-match tie-breaking: earliest in `a`,
 * then earliest in `b`).
 */

export type MatchBlock = [number, number, number];
export type Opcode = ["replace" | "delete" | "insert" | "equal", number, number, number, number];

export class SequenceMatcher<T> {
  private readonly a: T[];
  private readonly b: T[];
  private readonly b2j = new Map<T, number[]>();
  private blocks: MatchBlock[] | null = null;

  constructor(a: T[], b: T[]) {
    this.a = a;
    this.b = b;
    b.forEach((elt, i) => {
      const list = this.b2j.get(elt);
      if (list) list.push(i);
      else this.b2j.set(elt, [i]);
    });
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): MatchBlock {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): MatchBlock[] {
    if (this.blocks) return this.blocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const found: MatchBlock[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        found.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let [i1, j1, k1] = [0, 0, 0];
    const blocks: MatchBlock[] = [];
    for (const [i2, j2, k2] of found) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) blocks.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) blocks.push([i1, j1, k1]);
    blocks.push([la, lb, 0]);
    this.blocks = blocks;
    return blocks;
  }

  getOpcodes(): Opcode[] {
    let i = 0;
    let j = 0;
    const out: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : null;
      if (tag) out.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) out.push(["equal", ai, i, bj, j]);
    }
    return out;
  }
}
