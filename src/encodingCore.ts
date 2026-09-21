/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * 编码探测与统一核心库 —— core.py 的 TypeScript 移植。
 *
 * 设计与 Python 版完全一致：
 *  - 仅做严格解码判断（strict），绝不用 errors='replace' 生成可写回内容；
 *  - utf-8 / utf-8-sig / gbk / binary / unknown 的探测启发式相同；
 *  - 仅在编码可唯一确定时自动转码；UTF-8 与 GBK 双可解的文件必须人工复核，
 *    以避免将原本正常的 UTF-8 中文按 GBK 二次转码为乱码；
 *  - 统一目标默认 UTF-8 无 BOM + LF。
 */

import * as fs from "fs";
import * as path from "path";
import { TextDecoder } from "util";

export type Encoding = "utf-8" | "utf-8-sig" | "gbk" | "binary" | "unknown";
export type Confidence = "high" | "medium" | "low";
export type Action = "keep" | "convert" | "skip" | "review" | "converted";
export type NewlineMode = "lf" | "crlf" | "keep";

export const DEFAULT_EXTENSIONS = new Set<string>([
  ".c", ".h", ".cpp", ".hpp", ".cc", ".s", ".inc", ".txt", ".md",
  ".cmake", ".ld", ".lds", ".json", ".yml", ".yaml", ".ini", ".cfg",
  ".py", ".uvprojx", ".uvoptx", ".uvguix", ".xml",
]);

export const DEFAULT_EXCLUDE_DIRS = new Set<string>([
  ".git", ".svn", ".hg", ".cache", "node_modules", "out", "_build",
  "build", "Objects", "Listings", "__pycache__", ".vscode", ".idea",
  "_encoding_backup",
]);

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasBom(data: Buffer): boolean {
  return data.length >= BOM.length && data.subarray(0, BOM.length).equals(BOM);
}

function stripBom(data: Buffer): Buffer {
  return hasBom(data) ? data.subarray(BOM.length) : data;
}

export interface FileEncodingInfo {
  path: string;
  encoding: Encoding;
  confidence: Confidence;
  size: number;
  hasBom: boolean;
  hasCjk: boolean;
  note: string;
  action: Action;
}

export interface ScanReport {
  root: string;
  targetEncoding: string;
  scannedAt: string;
  files: FileEncodingInfo[];
  errors: string[];
}

export interface ScanOptions {
  targetEncoding?: string;
  extensions?: Iterable<string>;
  excludeDirs?: Iterable<string>;
}

export interface ProgressCb {
  (current: number, total: number, rel: string): void;
}

/** UTF-8 严格解码；失败返回 null。 */
function tryDecodeUtf8(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** UTF-8-sig 严格解码（吃掉 BOM）；非 BOM 开头也尝试整段 utf-8。失败返回 null。 */
function tryDecodeUtf8Sig(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(stripBom(data));
  } catch {
    return null;
  }
}

/** GBK 严格解码；失败返回 null。 */
function tryDecodeGbk(data: Buffer): string | null {
  try {
    return new TextDecoder("gbk", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function countCjk(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) n++;
  }
  return n;
}

function looksBinary(data: Buffer): boolean {
  if (data.length === 0) return false;
  // NUL in first 8KB
  const head = data.subarray(0, Math.min(data.length, 8192));
  if (head.indexOf(0) >= 0) return true;
  // high ratio of non-text control bytes
  let ctrl = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) ctrl++;
  }
  return ctrl / Math.max(head.length, 1) > 0.3;
}

/** 判定纯 ASCII（可 ascii round-trip）。 */
function isPureAscii(data: Buffer): boolean {
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 0x7f) return false;
  }
  return true;
}

/**
 * 探测字节流的编码。
 * 返回 [encoding, confidence, note]，与 Python detect_encoding 逻辑一致。
 */
export function detectEncoding(data: Buffer): [Encoding, Confidence, string] {
  if (looksBinary(data)) {
    return ["binary", "high", "含 NUL/控制字节，按二进制跳过"];
  }

  if (hasBom(data)) {
    if (tryDecodeUtf8Sig(data) !== null) {
      return ["utf-8-sig", "high", "带 UTF-8 BOM"];
    }
  }

  const utf8Text = tryDecodeUtf8(data);
  const gbkText = tryDecodeGbk(data);
  const utf8Ok = utf8Text !== null;
  const gbkOk = gbkText !== null;

  if (utf8Ok && !gbkOk) return ["utf-8", "high", "仅 UTF-8 可严格解码"];
  if (gbkOk && !utf8Ok) return ["gbk", "high", "仅 GBK 可严格解码"];

  if (utf8Ok && gbkOk) {
    if (isPureAscii(data)) return ["utf-8", "high", "纯 ASCII，记为 UTF-8"];

    // UTF-8 的部分中文字节序列同样符合 GBK 的字节规则。过去以两种解码结果
    // 的 CJK 数量来猜测来源编码，会把这类正常 UTF-8 文件误判为 GBK 并写回乱码。
    // 双可解没有无损且可靠的自动判定方式，因此绝不自动转换，交由用户复核。
    const cjkU = countCjk(utf8Text as string);
    const cjkG = countCjk(gbkText as string);
    return [
      "unknown",
      "low",
      `UTF-8/GBK 双可解（CJK utf8=${cjkU} gbk=${cjkG}），为防止误转乱码，需人工复核`,
    ];
  }

  return ["unknown", "low", "UTF-8/GBK 均无法严格解码"];
}

/** 与 Python decide_action 一致。 */
export function decideAction(
  enc: Encoding,
  confidence: Confidence,
  target = "utf-8"
): Action {
  if (enc === "binary") return "skip";
  if (enc === "unknown") return "review";
  if (enc === target || (enc === "utf-8-sig" && target === "utf-8")) {
    // utf-8-sig → utf-8 仍需转换（去 BOM）
    if (enc === "utf-8-sig" && target === "utf-8") return "convert";
    return "keep";
  }
  if ((enc === "gbk" || enc === "utf-8-sig") && target === "utf-8") {
    return confidence === "high" || confidence === "medium" ? "convert" : "review";
  }
  if (confidence === "low") return "review";
  return "convert";
}

export function decodeBytes(data: Buffer, encoding?: Encoding): [string, Encoding] {
  const enc = encoding ?? detectEncoding(data)[0];
  if (enc === "binary" || enc === "unknown") {
    throw new Error(`无法作为文本解码: ${enc}`);
  }
  if (enc === "utf-8-sig") {
    return [new TextDecoder("utf-8", { fatal: true }).decode(stripBom(data)), enc];
  }
  return [new TextDecoder(enc, { fatal: true }).decode(data), enc];
}

/** 规范后缀集合（补点、转小写）。 */
function normalizeExtSet(exts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (let e of exts) {
    e = e.toLowerCase();
    if (!e.startsWith(".")) e = "." + e;
    out.add(e);
  }
  return out;
}

/** 与 Python iter_source_files 一致：跳过排除目录与点开头的目录。 */
export function* iterSourceFiles(
  root: string,
  extensions?: Iterable<string>,
  excludeDirs?: Iterable<string>
): Iterable<string> {
  const exts = normalizeExtSet(extensions ?? DEFAULT_EXTENSIONS);
  const excl = new Set(
    [...(excludeDirs ?? DEFAULT_EXCLUDE_DIRS)].map((d) => d.toLowerCase())
  );
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const low = e.name.toLowerCase();
        if (!excl.has(low) && !low.startsWith(".")) stack.push(full);
      } else if (e.isFile()) {
        if (exts.has(path.extname(e.name).toLowerCase())) yield full;
      }
    }
  }
}

function oneFile(rootP: string, full: string): FileEncodingInfo {
  const rel = path.relative(rootP, full);
  const data = fs.readFileSync(full);
  const [enc, conf, note] = detectEncoding(data);
  let hasCjk = false;
  if (enc !== "binary" && enc !== "unknown") {
    try {
      const [text] = decodeBytes(data, enc);
      hasCjk = countCjk(text) > 0;
    } catch {
      hasCjk = false;
    }
  }
  return {
    path: rel.split(path.sep).join("/"),
    encoding: enc,
    confidence: conf,
    size: data.length,
    hasBom: enc === "utf-8-sig",
    hasCjk: hasCjk,
    note: note,
    action: decideAction(enc, conf, "utf-8"),
  };
}

/**
 * 扫描目录。options.progress 可选进度回调（非并发，顺序遍历以便稳定报告）。
 */
export function scanTree(
  root: string,
  options: ScanOptions = {},
  progress?: ProgressCb
): ScanReport {
  const rootP = path.resolve(root);
  const target = options.targetEncoding ?? "utf-8";
  const files: string[] = [...iterSourceFiles(rootP, options.extensions, options.excludeDirs)];
  const report: ScanReport = {
    root: rootP,
    targetEncoding: target,
    scannedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    files: [],
    errors: [],
  };
  const total = files.length;
  if (total === 0) return report;
  files.forEach((full, i) => {
    const rel = path.relative(rootP, full).split(path.sep).join("/");
    if (progress) progress(i + 1, total, rel);
    try {
      report.files.push(oneFile(rootP, full));
    } catch (err) {
      report.errors.push(`${rel}: ${(err as Error).message}`);
    }
  });
  return report;
}

export interface NormalizeOptions extends ScanOptions {
  dryRun?: boolean;
  onlyActions?: Action[];
  backup?: boolean;
  newline?: NewlineMode;
}

function stampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "_" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/**
 * 单文件转码写盘。与 Python convert_file 一致：
 *  - 内部先规范化为 \n，再按目标 eol 重新展开，避免混用换行；
 *  - newline=keep 时保留原文件首次出现的换行风格。
 */
export function convertFile(
  full: string,
  fromEncoding: Encoding,
  toEncoding: string = "utf-8",
  newline: NewlineMode = "keep",
  backupDir?: string
): void {
  const data = fs.readFileSync(full);
  const text =
    fromEncoding === "utf-8-sig"
      ? new TextDecoder("utf-8", { fatal: true }).decode(stripBom(data))
      : new TextDecoder(fromEncoding, { fatal: true }).decode(data);

  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    const safe = full.replace(/:/g, "").replace(/[\\/]/g, "__");
    fs.copyFileSync(full, path.join(backupDir, `${safe}.${stampName()}.bak`));
  }

  let eol: string;
  if (newline === "keep") {
    eol = data.includes(Buffer.from([0x0d, 0x0a])) ? "\r\n" : "\n";
  } else if (newline === "crlf") {
    eol = "\r\n";
  } else {
    eol = "\n";
  }
  // 规范内部为 \n 再按目标 eol 展开
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out = normalized.replace(/\n/g, eol);

  let buf: Buffer;
  if (toEncoding === "utf-8") {
    buf = Buffer.from(out, "utf-8");
  } else if (toEncoding === "utf-8-sig") {
    buf = Buffer.concat([BOM, Buffer.from(out, "utf-8")]);
  } else {
    buf = Buffer.from(out, toEncoding as BufferEncoding);
  }
  fs.writeFileSync(full, buf);
}

/**
 * 扫描并（可选）转换。dryRun=true 只扫描不写盘。
 */
export function normalizeTree(
  root: string,
  options: NormalizeOptions = {},
  progress?: ProgressCb
): ScanReport {
  const target = options.targetEncoding ?? "utf-8";
  const report = scanTree(
    root,
    { targetEncoding: target, extensions: options.extensions, excludeDirs: options.excludeDirs },
    progress
  );

  if (options.dryRun) return report;

  const rootP = report.root;
  const backupDir = options.backup !== false ? path.join(rootP, "_encoding_backup") : undefined;
  const only = options.onlyActions ?? (["convert"] as Action[]);
  const targets = report.files.filter((f) => only.includes(f.action));
  const total = targets.length;
  targets.forEach((info, i) => {
    const full = path.join(rootP, info.path);
    if (progress) progress(i + 1, total, info.path);
    try {
      convertFile(
        full,
        info.encoding,
        target,
        options.newline ?? "keep",
        backupDir
      );
      info.note = (info.note + " | converted").replace(/^\s\|\s/, "").trim();
      info.action = "converted";
      info.encoding = "utf-8";
    } catch (err) {
      report.errors.push(`${info.path}: convert failed: ${(err as Error).message}`);
      info.action = "review";
      info.note = `convert failed: ${(err as Error).message}`;
    }
  });
  return report;
}

/** 报告摘要，供 UI 展示。 */
export function summarize(report: ScanReport): {
  total: number;
  toConvert: number;
  needReview: number;
  byEncoding: Record<string, number>;
  errors: number;
} {
  const byEncoding: Record<string, number> = {};
  let toConvert = 0;
  let needReview = 0;
  for (const f of report.files) {
    byEncoding[f.encoding] = (byEncoding[f.encoding] ?? 0) + 1;
    if (f.action === "convert") toConvert++;
    if (f.action === "review") needReview++;
  }
  return {
    total: report.files.length,
    toConvert,
    needReview,
    byEncoding,
    errors: report.errors.length,
  };
}
