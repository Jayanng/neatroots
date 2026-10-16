// TOML entry scanning for the Codex config: find and remove our [mcp_servers.<name>]
// entry however it is spelled, leaving the rest of the file byte-for-byte.
//
// The same table can be spelled several ways: [mcp_servers."neatroots"] names the same
// table as [mcp_servers.neatroots], a definition can be dotted (mcp_servers.neatroots =
// { ... }), and a bracketed line inside a multi-line string is string content, not a
// table header. Quotes inside a # comment are comment, not code: a `# use """ for long
// strings` comment must never open a string that swallows the rest of the file. Missing
// a spelling adds a second definition of the same table, which is invalid TOML and stops
// the agent reading its whole config; treating string content as a header, comments as
// code, or a multi-line value as one line corrupts the file.

import fs from "node:fs";

export const SERVER_NAME = "neatroots";
/** Names we have ever shipped under: stripped on removal, but not "connected" for status. */
export const LEGACY_NAMES = ["neatbolt"];

const OUR_NAMES = new Set([SERVER_NAME, ...LEGACY_NAMES]);

/** Key path of a dotted TOML key or header body, with quotes removed: 'a."b".c' -> [a, b, c]. */
function tomlKeyPath(text: string): string[] {
  const parts: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s"']+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    parts.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  }
  return parts;
}

/** Our entry: mcp_servers.<ours>, with anything below it (sub-tables, sub-keys). */
function isOursPath(full: string[]): boolean {
  return full[0] === "mcp_servers" && full.length >= 2 && OUR_NAMES.has(full[1]);
}

function tomlTablePath(line: string): string[] | null {
  const m = /^\[\[?([^\]]+)\]\]?\s*$/.exec(line.trim());
  return m ? tomlKeyPath(m[1]) : null;
}

/**
 * The multi-line string (""" or ''') a line leaves open, honouring single-line strings.
 * Scanning stops at the first unquoted # : the rest of the line is a comment, so its
 * quotes and delimiters never open or close a string.
 */
function multiOpenAfter(line: string, was: string | null): string | null {
  let ml = was;
  let i = 0;
  while (i < line.length) {
    if (ml) {
      const at = line.indexOf(ml, i);
      if (at < 0) return ml;
      if (ml === '"""' && at > 0 && line[at - 1] === "\\") {
        i = at + 3;
        continue;
      }
      ml = null;
      i = at + 3;
      continue;
    }
    const ch = line[i];
    if (ch === "#") return null; // comment: the rest of the line is not code
    if (line.startsWith('"""', i)) {
      ml = '"""';
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      ml = "'''";
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < line.length && line[i] !== ch) i += ch === '"' && line[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return ml;
}

/**
 * Collapses the blank run at each removal seam to at most one blank line — the old
 * global /\n{3,}/ rewrite also rewrote blank lines inside other entries' multi-line
 * strings. Everywhere else the file is untouched.
 */
function collapseAtSeams(lines: string[], seams: number[]): string {
  const drop = new Set<number>();
  for (const s of new Set(seams)) {
    let a = s;
    let b = s;
    while (a > 0 && lines[a - 1].trim() === "") a--;
    while (b < lines.length && lines[b].trim() === "") b++;
    for (let i = a; i < b - 1; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

export interface TomlScan {
  text: string;
  /** The current server name is defined. */
  server: boolean;
  /** A legacy name is defined (stripped on removal, never "connected"). */
  legacy: boolean;
}

/**
 * Removes our entry however it is spelled, leaving everything else as written. Inline
 * tables are single-line by the TOML spec, so a dotted definition of our key always ends
 * on its own line — but its value can be a multi-line string, whose lines are dropped
 * with it until the delimiter closes.
 */
export function scanToml(text: string): TomlScan {
  const out: string[] = [];
  const seams: number[] = [];
  let server = false;
  let legacy = false;
  let skipping = false;
  let mlFromOursKey = false;
  let ml: string | null = null;
  let table: string[] = [];

  const saw = (path: string[]) => {
    if (path[1] === SERVER_NAME) server = true;
    else legacy = true;
  };
  const drop = () => seams.push(out.length);
  const keep = (line: string) => out.push(line);

  for (const line of text.split("\n")) {
    if (ml) {
      ml = multiOpenAfter(line, ml);
      if (skipping) drop();
      else keep(line);
      if (!ml && mlFromOursKey) {
        mlFromOursKey = false;
        skipping = false;
      }
      continue;
    }
    const t = line.trim();
    if (t.startsWith("#")) {
      if (skipping) drop();
      else keep(line);
      continue;
    }
    const header = t.startsWith("[") ? tomlTablePath(t) : null;
    if (header) {
      table = header;
      skipping = isOursPath(header);
      if (skipping) {
        saw(header);
        drop();
      } else keep(line);
      continue;
    }
    const eq = t.indexOf("=");
    const key = eq > 0 ? t.slice(0, eq).trim() : "";
    const path = Boolean(key) && !/[[\]{}]/.test(key) ? [...table, ...tomlKeyPath(key)] : null;
    if (path && isOursPath(path)) {
      saw(path);
      drop();
      ml = multiOpenAfter(line, null);
      if (ml) {
        mlFromOursKey = true;
        skipping = true;
      }
      continue;
    }
    if (skipping) drop();
    else keep(line);
    ml = multiOpenAfter(line, null);
  }
  return { text: collapseAtSeams(out, seams), server, legacy };
}

export function stripTomlEntry(text: string): string {
  return scanToml(text).text;
}

/** Only the current server name counts as connected; legacy names are cleanup-only. */
export function tomlHas(file: string): boolean {
  return fs.existsSync(file) && scanToml(fs.readFileSync(file, "utf8")).server;
}
