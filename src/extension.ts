/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as vscode from "vscode";
import * as path from "path";
import {
  normalizeTree,
  summarize,
  DEFAULT_EXTENSIONS,
  DEFAULT_EXCLUDE_DIRS,
  type NewlineMode,
} from "./encodingCore";

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("编码统一");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("encodingUnify.unify", () => runUnify())
  );

  // 状态栏按钮：底栏一个入口
  const statusBtn = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBtn.command = "encodingUnify.unify";
  statusBtn.text = "$(encoding) 编码统一";
  statusBtn.tooltip = "扫描当前目录并统一为 UTF-8 无 BOM + LF";
  context.subscriptions.push(statusBtn);
  statusBtn.show();
}

export function deactivate(): void {
  /* noop */
}

/* ---------- 配置读取 ---------- */

interface ResolvedConfig {
  extensions: string[];
  excludeDirs: string[];
  newline: NewlineMode;
  backup: boolean;
}

function readConfig(): ResolvedConfig {
  const cfg = vscode.workspace.getConfiguration("encodingUnify");
  return {
    extensions: cfg.get<string[]>("defaultExtensions") ?? [...DEFAULT_EXTENSIONS],
    excludeDirs: cfg.get<string[]>("excludeDirs") ?? [...DEFAULT_EXCLUDE_DIRS],
    newline: cfg.get<"lf" | "crlf" | "keep">("targetNewline", "lf"),
    backup: cfg.get<boolean>("backup", true),
  };
}

/* ---------- 主流程 ---------- */

async function runUnify(): Promise<void> {
  // 取当前工作区根目录
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showWarningMessage("请先在 VS Code 中打开一个目录");
    return;
  }

  const cfg = readConfig();

  // 1) 先扫描（不写盘）
  output.show(true);
  output.clear();
  output.appendLine(`编码统一 · 扫描目录: ${folder}`);
  output.appendLine(
    `后缀 ${cfg.extensions.join(", ")} · 排除 ${cfg.excludeDirs.join(", ")} · 换行 ${cfg.newline} · 备份 ${cfg.backup}`
  );
  output.appendLine("");

  let scanReport: ReturnType<typeof normalizeTree> | null = null;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "编码统一: 扫描中",
      cancellable: false,
    },
    async (progress) => {
      scanReport = normalizeTree(
        folder,
        {
          dryRun: true,
          extensions: cfg.extensions,
          excludeDirs: cfg.excludeDirs,
          newline: cfg.newline,
          backup: cfg.backup,
        },
        (cur, total, rel) =>
          progress.report({
            increment: total ? (cur / total) * 100 : 0,
            message: `${cur}/${total} ${shortRel(rel)}`,
          })
      );
    }
  );
  if (!scanReport) return;
  printReport(scanReport, true);

  const s = summarize(scanReport);
  const pending = s.toConvert + s.needReview;

  // 2) 没有待处理 → 直接提示，不弹确认
  if (pending === 0 && s.errors === 0) {
    vscode.window.showInformationMessage(
      `编码统一: 共 ${s.total} 个文件，全部已是 UTF-8 无 BOM + LF，无需转码。`
    );
    return;
  }

  // 3) 有待处理 → 弹窗显示报告，点"确定转码"才写盘
  const distStr = Object.entries(s.byEncoding)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");

  const confirm = await vscode.window.showInformationMessage(
    `共 ${s.total} 个文件\n` +
      `待转码 ${s.toConvert}  ·  待复核 ${s.needReview}  ·  错误 ${s.errors}\n` +
      `编码分布: ${distStr}\n\n` +
      `将统一为 UTF-8 无 BOM + ${newlineLabel(cfg.newline)}` +
      `${cfg.backup ? "（自动备份到 _encoding_backup）" : "（不备份）"}`,
    { modal: true },
    "确定转码",
    "取消"
  );

  if (confirm !== "确定转码") return;

  // 4) 执行转码
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "编码统一: 转码中",
      cancellable: false,
    },
    async (progress) => {
      scanReport = normalizeTree(
        folder,
        {
          dryRun: false,
          extensions: cfg.extensions,
          excludeDirs: cfg.excludeDirs,
          newline: cfg.newline,
          backup: cfg.backup,
        },
        (cur, total, rel) =>
          progress.report({
            increment: total ? (cur / total) * 100 : 0,
            message: `${cur}/${total} ${shortRel(rel)}`,
          })
      );
    }
  );
  if (!scanReport) return;

  output.appendLine("");
  output.appendLine("【转码后】");
  printReport(scanReport, false);

  const s2 = summarize(scanReport);
  vscode.window.showInformationMessage(
    `编码统一完成: 已处理 ${s2.total} 个文件` +
      `${cfg.backup ? "（备份在 _encoding_backup）" : ""}` +
      ` · 待复核 ${s2.needReview} · 错误 ${s2.errors}`
  );
}

/* ---------- 工具 ---------- */

function shortRel(rel: string): string {
  return rel.length <= 48 ? rel : "…" + rel.slice(-47);
}

function newlineLabel(nl: NewlineMode): string {
  return nl === "lf" ? "LF" : nl === "crlf" ? "CRLF" : "保留原换行";
}

function printReport(
  report: ReturnType<typeof normalizeTree>,
  dryRun: boolean
): void {
  const s = summarize(report);
  output.appendLine(
    `${dryRun ? "仅检查" : "已统一为 UTF-8 无 BOM"} · 文件 ${s.total} · 待转码 ${s.toConvert} · 待复核 ${s.needReview}`
  );
  output.appendLine(`分布 ${JSON.stringify(s.byEncoding)}`);
  if (report.errors.length) {
    output.appendLine("错误（节选）:");
    for (const e of report.errors.slice(0, 8)) output.appendLine(`  - ${e}`);
  }
  const todo = report.files.filter(
    (f) => f.action === "convert" || f.action === "review"
  );
  if (todo.length) {
    output.appendLine("待处理文件:");
    for (const f of todo.slice(0, 30)) {
      output.appendLine(
        `  [${f.action}] ${f.path} · ${f.encoding} (${f.confidence}) ${f.note}`
      );
    }
    if (todo.length > 30) output.appendLine(`  … 共 ${todo.length} 项`);
  }
  output.appendLine("");
}
