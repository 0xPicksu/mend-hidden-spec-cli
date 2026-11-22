// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ---- mend: the three formats the starter leaves open, and 3-tier matching ---- */

// Moves recorded by edits that succeed, so the output can print `R old -> new`
// instead of a `D`/`A` pair. Chained moves are folded into one record.
const moves: { old: string; new: string }[] = [];
function recordMove(oldP: string, newP: string): void {
  for (const m of moves) {
    if (m.new === oldP) {
      if (m.old === newP) moves.splice(moves.indexOf(m), 1);
      else m.new = newP;
      return;
    }
  }
  moves.push({ old: oldP, new: newP });
}

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function tierKey(s: string, tier: number): string {
  if (tier === 1) return trimEndWs(s);
  if (tier === 2) return trimWs(s);
  return s;
}
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (tierKey(lines[i + j]!, tier) !== tierKey(old[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, old, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}
// ctxMap[j] is the index into O of the j-th line of N when that line is a context
// line, or -1 for a line only N carries.
function buildNew(old: string[], nw: string[], ctxMap: number[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = fileLines.length > pos && old.length > 0 ? leadWs(fileLines[pos]!) : '';
  const p = old.length > 0 ? leadWs(old[0]!) : '';
  for (let j = 0; j < nw.length; j += 1) {
    if (ctxMap[j]! >= 0) { out.push(fileLines[pos + ctxMap[j]!]!); continue; }
    const line = nw[j]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}
function applyReplace(state: FileState, old: string[], nw: string[], ctxMap: number[], pos: number, strict: boolean, path: string): FileState {
  const found = findTier(state.lines, old, strict);
  if (found === null) throw new Fail('no-match', path);
  return { br: state.br, lines: [...state.lines.slice(0, pos), ...buildNew(old, nw, ctxMap, state.lines, pos, found.tier), ...state.lines.slice(pos + old.length)], final: state.final };
}

// A hunk/chunk body, parsed from its raw lines.
interface BodyItem { kind: 'ctx' | 'del' | 'add'; text: string }
interface Body { items: BodyItem[]; noNl: boolean; lastPlusNoNl: boolean | null }
function parseBody(raw: string[]): Body {
  const items: BodyItem[] = [];
  let lastCtxAdd = -1;
  let lastPlus = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const l = raw[i]!;
    if (l.startsWith(' ')) { items.push({ kind: 'ctx', text: l.slice(1) }); lastCtxAdd = i; }
    else if (l.startsWith('-')) items.push({ kind: 'del', text: l.slice(1) });
    else if (l.startsWith('+')) { items.push({ kind: 'add', text: l.slice(1) }); lastCtxAdd = i; lastPlus = i; }
    else if (l === '') { items.push({ kind: 'ctx', text: '' }); lastCtxAdd = i; }
    // a `\` line is not an item; it only marks the line before it.
  }
  const noNl = lastCtxAdd >= 0 && raw[lastCtxAdd + 1] !== undefined && raw[lastCtxAdd + 1]!.startsWith('\\');
  const lastPlusNoNl = lastPlus < 0 ? null : (raw[lastPlus + 1] !== undefined && raw[lastPlus + 1]!.startsWith('\\'));
  return { items, noNl, lastPlusNoNl };
}
function bodyOldNew(body: Body): { old: string[]; nw: string[]; ctxMap: number[] } {
  const old: string[] = [];
  const nw: string[] = [];
  const ctxMap: number[] = [];
  for (const it of body.items) {
    if (it.kind === 'ctx') { ctxMap.push(old.length); old.push(it.text); nw.push(it.text); }
    else if (it.kind === 'del') old.push(it.text);
    else { ctxMap.push(-1); nw.push(it.text); }
  }
  return { old, nw, ctxMap };
}
const isBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
function headerPath(raw: string): string {
  const t = raw.slice(4);
  const tab = t.indexOf('\t');
  return (tab < 0 ? t : t.slice(0, tab)).trim();
}

/* ---- unified diffs (SPEC section 6) ---- */
interface Hunk { a: number; body: Body; raw: string[] }
interface Section {
  pairOld?: string; pairNew?: string; renameOld?: string; renameNew?: string;
  gitOld?: string; gitNew?: string; isNew: boolean; isDeleted: boolean; hunks: Hunk[];
}
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  let j = i + 1;
  const raw: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (!isBodyLine(l)) break;
    raw.push(l);
    j += 1;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return { hunk: { a: Number(m[1]), body: parseBody(raw), raw }, next: j };
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const push = (): void => { if (cur !== null) sections.push(cur); cur = null; };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = { gitOld: m[1], gitNew: m[2], isNew: false, isDeleted: false, hunks: [] };
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = stripPrefix(headerPath(l));
        cur.pairNew = stripPrefix(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      push();
      cur = { pairOld: stripPrefix(headerPath(l)), pairNew: stripPrefix(headerPath(lines[i + 1]!)), isNew: false, isDeleted: false, hunks: [] };
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        inHeader = false;
        i = r.next;
        continue;
      }
      if (l.startsWith('rename from ')) cur.renameOld = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDeleted = true;
      i += 1;
      continue;
    }
    if (cur !== null) {
      if (l.startsWith('@@')) {
        const r = parseHunk(lines, i);
        cur.hunks.push(r.hunk);
        i = r.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  push();
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.pairOld ?? s.renameOld ?? s.gitOld ?? '';
    const newPath = s.pairNew ?? s.renameNew ?? s.gitNew ?? '';
    const isCreate = oldPath === '/dev/null' || s.isNew;
    const isDelete = newPath === '/dev/null' || s.isDeleted;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (isCreate) {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        let lastNoNl: boolean | null = null;
        for (const h of hunks) {
          for (const it of h.body.items) if (it.kind === 'add') plus.push(it.text);
          if (h.body.lastPlusNoNl !== null) lastNoNl = h.body.lastPlusNoNl;
        }
        const fin = plus.length === 0 ? false : !(lastNoNl ?? false);
        tree.now.set(newPath, plus.length === 0 ? '' : `${plus.join('\n')}${fin ? '\n' : ''}`);
        return;
      }
      if (isDelete) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath !== newPath) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        let state = splitFile(before);
        let d = 0;
        for (const h of hunks) {
          state = applyUnifiedHunk(state, h, d, strict, oldPath);
          const on = bodyOldNew(h.body);
          d += on.nw.length - on.old.length;
        }
        tree.now.set(newPath, joinFile(state));
        tree.now.set(oldPath, null);
        recordMove(oldPath, newPath);
        return;
      }
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      let state = splitFile(before);
      let d = 0;
      for (const h of hunks) {
        state = applyUnifiedHunk(state, h, d, strict, oldPath);
        const on = bodyOldNew(h.body);
        d += on.nw.length - on.old.length;
      }
      tree.now.set(oldPath, joinFile(state));
    });
  }
  return edits;
}
function applyUnifiedHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, path: string): FileState {
  const { old, nw, ctxMap } = bodyOldNew(hunk.body);
  if (old.length === 0) {
    const at = Math.min(hunk.a + d, state.lines.length);
    const built = buildNew(old, nw, ctxMap, state.lines, at, 0);
    const lines = [...state.lines.slice(0, at), ...built, ...state.lines.slice(at)];
    let fin = state.final;
    if (at === state.lines.length && built.length > 0) fin = !hunk.body.noNl;
    return { br: state.br, lines, final: fin };
  }
  const found = findTier(state.lines, old, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.occ[0]!;
  for (const p of found.occ) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  const built = buildNew(old, nw, ctxMap, state.lines, pos, found.tier);
  const lines = [...state.lines.slice(0, pos), ...built, ...state.lines.slice(pos + old.length)];
  let fin = state.final;
  if (pos + old.length === state.lines.length) {
    fin = nw.length === 0 ? lines.length > 0 : !hunk.body.noNl;
  }
  return { br: state.br, lines, final: fin };
}

/* ---- SEARCH/REPLACE blocks (SPEC section 7) ---- */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let k = searchLine + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') { sep = k; break; }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { end = k; break; }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const state = splitFile(before);
      const found = findTier(state.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const built = buildNew(oldLines, newLines, newLines.map(() => -1), state.lines, pos, found.tier);
      const out: string[] = [...state.lines.slice(0, pos), ...built, ...state.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile({ br: state.br, lines: out, final: state.final }));
    });
    prevPath = p;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ---- V4A patches (SPEC section 8) ---- */
interface VChunk { anchor: string | null; body: Body; eof: boolean }
interface VSection {
  kind: 'add' | 'delete' | 'update'; path: string; moveTo?: string;
  addLines?: string[]; chunks?: VChunk[]; lineNo: number;
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.startsWith('*** Add File: ')) {
      const sec: VSection = { kind: 'add', path: l.slice(14).trim(), lineNo: i + 1, addLines: [] };
      i += 1;
      // A `+` line with nothing after it is a file line that is empty; a
      // patch line that is empty is only a blank separator. Only the
      // separators at the end of the section are dropped.
      const got: { t: string; plus: boolean }[] = [];
      while (i < last && (lines[i]!.startsWith('+') || lines[i]! === '')) {
        got.push(lines[i]!.startsWith('+') ? { t: lines[i]!.slice(1), plus: true } : { t: '', plus: false });
        i += 1;
      }
      while (got.length > 0 && !got[got.length - 1]!.plus) got.pop();
      sec.addLines = got.map((g) => g.t);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: l.slice(17).trim(), lineNo: i + 1 });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const sec: VSection = { kind: 'update', path: l.slice(17).trim(), lineNo: i + 1, chunks: [] };
      i += 1;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      let firstChunk = true;
      while (i < last) {
        const c = lines[i]!;
        if (c.startsWith('*** Add File: ') || c.startsWith('*** Delete File: ') || c.startsWith('*** Update File: ')) break;
        if (blank(c) && !firstChunk) {
          // A blank line between chunks is an empty context line of the
          // previous chunk only when the previous chunk is still open; here
          // a chunk has just ended, so skip separator blanks.
          i += 1;
          continue;
        }
        let anchor: string | null = null;
        let eof = false;
        if (c.startsWith('@@')) {
          anchor = c.slice(2).trim();
          i += 1;
        } else if (!firstChunk) break;
        const raw: string[] = [];
        while (i < last) {
          const b = lines[i]!;
          if (b.startsWith('@@') || b.trim() === '*** End of File') break;
          if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
          if (!isBodyLine(b)) throw new Exit2(`error: parse ${i + 1}`);
          raw.push(b);
          i += 1;
        }
        // Blank lines at the very end of the section are not part of it: a
        // patch line that is empty or only whitespace counts as blank here,
        // so a trailing ' ' context line is stripped too.
        const nextIsSection = i < last && (lines[i]!.startsWith('*** Add File: ') || lines[i]!.startsWith('*** Delete File: ') || lines[i]!.startsWith('*** Update File: '));
        if (i >= last || nextIsSection) while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
        if (i < last && lines[i]!.trim() === '*** End of File') { eof = true; i += 1; }
        sec.chunks!.push({ anchor, body: parseBody(raw), eof });
        firstChunk = false;
      }
      if (sec.chunks!.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const addLines = s.addLines!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, addLines.length === 0 ? '' : `${addLines.join('\n')}\n`);
      });
    } else if (s.kind === 'delete') {
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = s.path;
      const moveTo = s.moveTo;
      const chunks = s.chunks!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const state = splitFile(before);
        let linesNow = state.lines;
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            let foundAt = -1;
            for (const tier of (strict ? [0] : [0, 1, 2])) {
              for (let k = cursor; k < linesNow.length; k += 1) {
                if (tierKey(linesNow[k]!, tier) === tierKey(ch.anchor, tier)) { foundAt = k; break; }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          const { old, nw, ctxMap } = bodyOldNew(ch.body);
          if (old.length === 0) {
            const at = ch.eof ? linesNow.length : cursor;
            const built = nw.map((x) => x);
            linesNow = [...linesNow.slice(0, at), ...built, ...linesNow.slice(at)];
            cursor = at + built.length;
            continue;
          }
          let pos = -1;
          let tierUsed = 0;
          for (const tier of (strict ? [0] : [0, 1, 2])) {
            const occ = occurrences(linesNow, old, tier).filter((q) => q >= cursor && (!ch.eof || q + old.length === linesNow.length));
            if (occ.length > 0) { pos = occ[0]!; tierUsed = tier; break; }
          }
          if (pos < 0) throw new Fail('no-match', p);
          const built = buildNew(old, nw, ctxMap, linesNow, pos, tierUsed);
          linesNow = [...linesNow.slice(0, pos), ...built, ...linesNow.slice(pos + old.length)];
          cursor = pos + built.length;
        }
        const out = joinFile({ br: state.br, lines: linesNow, final: state.final });
        if (moveTo !== undefined) {
          tree.now.set(moveTo, out);
          tree.now.set(p, null);
          recordMove(p, moveTo);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
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
  moves.length = 0;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rowItems: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const m of moves) {
    const o = changed.get(m.old);
    const n = changed.get(m.new);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null) {
      rowItems.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      used.add(m.old);
      used.add(m.new);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rowItems.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rowItems.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowItems.map((r) => r.line);
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
