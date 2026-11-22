// mend: one patch tool for every AI edit format. SPEC.md (version 1) is the whole contract: it reads a patch in
// one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none. Node 22, the standard library alone;
// run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A patch's lines: its text split at `\n`, each with one trailing `\r` removed, without the empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break is CRLF when its first line feed follows a carriage return, LF otherwise. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Line equality at one matching tier: exact, trailing spaces and tabs removed, or both sides removed. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimBothWS(a) === trimBothWS(b);
}

/** Start positions i >= from where O matches lines[i..i+|O|-1] at tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const start = Math.max(0, from);
  if (tier === 0) {
    for (let i = start; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (O[j] !== lines[i + j]) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(i);
    }
    return out;
  }
  const norm = tier === 1 ? trimEndWS : trimBothWS;
  const oNorm = O.map(norm);
  const lNorm = lines.map(norm);
  for (let i = start; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (oNorm[j] !== lNorm[i + j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when it occurs at no tier. */
function firstTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occurrences(O, lines, t, from);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/**
 * The lines that replace a matched block. A context line of N is the file's own matched line, never the patch's.
 * At tier 2 every other line of N is re-indented: a line that is not empty and not only whitespace, and starts
 * with P (the leading spaces and tabs of O's first line), has that P replaced by F (those of the file's first
 * matched line). nCtx[j] is the index in O of the context line N[j] is, or -1 when N[j] is a new line.
 */
function buildReplacement(fileLines: string[], at: number, O: string[], N: string[], nCtx: number[], tier: number): string[] {
  const p = leadingWS(O.length > 0 ? O[0]! : '');
  const f = leadingWS(fileLines[at] ?? '');
  return N.map((line, j) => {
    const ci = nCtx[j]!;
    if (ci >= 0) return fileLines[at + ci]!;
    if (tier === 2 && line !== '' && !/^[ \t]*$/.test(line) && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

/** O, N and the context map of one hunk or chunk body: ' ' and empty lines are context, '-' old, '+' new. */
function bodyON(body: string[]): { O: string[]; N: string[]; nCtx: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: number[] = [];
  for (const bl of body) {
    if (bl.startsWith('\\')) continue;
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      O.push(t);
      nCtx.push(O.length - 1);
      N.push(t);
    } else if (bl.startsWith('-')) {
      O.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      N.push(bl.slice(1));
      nCtx.push(-1);
    } else if (bl === '') {
      O.push('');
      nCtx.push(O.length - 1);
      N.push('');
    }
  }
  return { O, N, nCtx };
}

/** Whether a `\` line follows the hunk's last context or `+` line (it says the result has no final line break). */
function backslashAfterLastN(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl.startsWith(' ') || bl.startsWith('+') || bl === '') last = k;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.startsWith('\\');
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs (SPEC.md section 6). A section is one edit; its hunks apply in order to the one path. */

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  hdrOld: string | null;
  hdrNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: the text after the four characters, up to the first tab, trimmed; a leading a/ or b/ removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHunk: Hunk | null = null;
  let inBody = false;

  const newSection = (): UniSection => {
    const s: UniSection = {
      hdrOld: null,
      hdrNew: null,
      renameFrom: null,
      renameTo: null,
      gitOld: null,
      gitNew: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    curHunk = null;
    inBody = false;
    return s;
  };

  const endBody = (): void => {
    if (curHunk !== null) {
      const b = curHunk.body;
      while (b.length > 0 && b[b.length - 1] === '') b.pop();
    }
    curHunk = null;
    inBody = false;
  };

  const hunkStart = (line: string): number | null => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    return m === null ? null : Number(m[1]);
  };

  const diffGitPaths = (line: string): [string, string] | null => {
    const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
    return m === null ? null : [m[1]!, m[2]!];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      if (line.startsWith('diff --git ')) {
        endBody();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        curHunk!.body.push(line);
        i++;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const g = diffGitPaths(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = g[0];
      s.gitNew = g[1];
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkStart(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a, body: [] };
      cur.hunks.push(curHunk);
      inBody = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const inHeader = cur !== null && cur.hunks.length === 0 && cur.hdrOld === null && cur.hdrNew === null && cur.gitOld !== null;
      if (inHeader) {
        cur!.hdrOld = headerPath(line);
        cur!.hdrNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      const s = newSection();
      s.hdrOld = headerPath(line);
      s.hdrNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (cur.hdrNew === null) cur.hdrNew = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renameFrom === null) cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renameTo === null) cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  endBody();

  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.hdrOld ?? sec.renameFrom ?? sec.gitOld;
  const newPath = sec.hdrNew ?? sec.renameTo ?? sec.gitNew;
  const isCreation = oldPath === '/dev/null' || sec.newFile;
  const isDeletion = !isCreation && (newPath === '/dev/null' || sec.deletedFile);
  const isMove = !isCreation && !isDeletion && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree: Tree) => {
    if (isCreation) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.startsWith('+')) {
            plus.push(h.body[k]!.slice(1));
            lastPlus = { hunk: h, idx: k };
          }
        }
      }
      let finalBreak = true;
      if (lastPlus !== null) {
        const { hunk, idx } = lastPlus;
        if (idx + 1 < hunk.body.length && hunk.body[idx + 1]!.startsWith('\\')) finalBreak = false;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDeletion) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = oldPath!;
    const newP = newPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N, nCtx } = bodyON(h.body);
      if (O.length === 0) {
        let idx = h.a + d;
        if (idx < 0) idx = 0;
        if (idx > f.lines.length) idx = f.lines.length;
        const atEnd = idx === f.lines.length;
        f.lines.splice(idx, 0, ...N);
        if (atEnd) f.final = !backslashAfterLastN(h.body);
        d += N.length;
      } else {
        const found = firstTier(O, f.lines, 0, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = found.occs[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.occs) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const rep = buildReplacement(f.lines, best, O, N, nCtx, found.tier);
        const runsToEnd = best + O.length === f.lines.length;
        f.lines.splice(best, O.length, ...rep);
        if (runsToEnd) f.final = !backslashAfterLastN(h.body);
        d += N.length - O.length;
      }
    }
    const out = renderFile(f);
    if (isMove) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, nw: newP });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). A block is one edit, applied in order. */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevReplaceEnd; k--) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let m = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        m = k;
        break;
      }
    }
    if (m === -1) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let k = m + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        r = k;
        break;
      }
    }
    if (r === -1) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, m), newLines: lines.slice(m + 1, r) });
    prevPath = path;
    prevReplaceEnd = r;
    i = r + 1;
  }
  return blocks.map((b) => srBlockEdit(b, strict));
}

function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(b.path);
    if (content === null) throw new Fail('missing', b.path);
    const f = parseFile(content);
    const found = firstTier(b.oldLines, f.lines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occs.length !== 1) throw new Fail('ambiguous', b.path);
    const at = found.occs[0]!;
    const nCtx = b.newLines.map(() => -1);
    const rep = buildReplacement(f.lines, at, b.oldLines, b.newLines, nCtx, found.tier);
    f.lines.splice(at, b.oldLines.length, ...rep);
    tree.now.set(b.path, renderFile(f));
  };
}

/** V4A patches (SPEC.md section 8). A section is one edit, applied in order. */

interface V4AChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: { text: string; num: number }[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push({ kind, path, lines: raw, updateLine: startLine });
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(sec: V4ASection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const l of sec.lines) {
      if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
      else if (l.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${l.num}`);
    }
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    if (sec.lines.length > 0) throw new Exit2(`error: parse ${sec.lines[0]!.num}`);
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  const rawLines = sec.lines;
  if (idx < rawLines.length && rawLines[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = rawLines[idx]!.text.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  for (; idx < rawLines.length; idx++) {
    const l = rawLines[idx]!;
    if (l.text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchorText = l.text.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
    } else if (l.text.startsWith(' ') || l.text.startsWith('-') || l.text.startsWith('+') || l.text === '') {
      if (cur === null) {
        if (chunks.length === 0) cur = { anchor: null, body: [], eof: false };
        else throw new Exit2(`error: parse ${l.num}`);
      }
      cur.body.push(l.text);
    } else if (l.text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${l.num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else {
      throw new Exit2(`error: parse ${l.num}`);
    }
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
  const built = chunks.map((c) => {
    const { O, N, nCtx } = bodyON(c.body);
    return { anchor: c.anchor, eof: c.eof, O, N, nCtx };
  });
  return (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(sec.path);
    if (content === null) throw new Fail('missing', sec.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(content);
    let cursor = 0;
    for (const c of built) {
      if (c.anchor !== null) {
        let pos: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineEq(c.anchor, f.lines[k]!, t)) {
              pos = k;
              break;
            }
          }
          if (pos !== null) break;
        }
        if (pos === null) throw new Fail('no-match', sec.path);
        cursor = pos + 1;
      }
      if (c.O.length === 0) {
        const at = c.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...c.N);
        cursor = at + c.N.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occs = occurrences(c.O, f.lines, t, cursor);
          const qual = c.eof ? occs.filter((p) => p + c.O.length === f.lines.length) : occs;
          if (qual.length > 0) {
            found = { tier: t, pos: qual[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', sec.path);
        const rep = buildReplacement(f.lines, found.pos, c.O, c.N, c.nCtx, found.tier);
        f.lines.splice(found.pos, c.O.length, ...rep);
        cursor = found.pos + rep.length;
      }
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push({ old: sec.path, nw: moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/** Detecting the format (SPEC.md section 4): the first of these that holds, in this order. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.now.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const c of changed) {
    if (covered.has(c.p)) continue;
    const k = c.was === null ? 'A' : c.now === null ? 'D' : 'M';
    rows.push({ key: c.p, line: `${k} ${c.p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
