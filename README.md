# 编码统一 (Encoding Unify)

把当前 VS Code 窗口打开的目录一键统一为 **UTF-8 无 BOM + LF**（含 GBK→UTF-8 转码、去 BOM、统一换行）。

点击底栏状态栏的「编码统一」按钮，扫描完成后弹窗告诉你有多少文件待转码、编码分布等，点「确定转码」即开始写盘。

## 使用

1. 在 VS Code 中打开一个目录（File → Open Folder）。
2. 点击底栏左下角的 **「$(encoding) 编码统一」** 状态栏按钮。
3. 扫描完成后弹出报告：
   - 共 N 个文件
   - 待转码 X · 待复核 Y · 错误 Z
   - 编码分布：utf-8=..、gbk=..、utf-8-sig=..
4. 点 **「确定转码」** 即开始统一（写盘前自动在目录下生成 `_encoding_backup` 备份）；点取消则不写盘。

若全部文件已对齐，则直接提示「无需转码」，不弹确认。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `encodingUnify.defaultExtensions` | 固件工程常见后缀集合 | 参与统一的后缀 |
| `encodingUnify.excludeDirs` | `.git`、`build`、`Objects` 等 | 扫描时跳过的目录 |
| `encodingUnify.targetNewline` | `lf` | 统一换行：`lf` / `crlf` / `keep` |
| `encodingUnify.backup` | `true` | 写盘前在目录下生成 `_encoding_backup` |

## 安装 VSIX

```sh
code --install-extension encoding-unify-0.2.1.vsix
```

## 与 Python 版的关系

核心算法使用严格解码（fatal），识别 utf-8 / utf-8-sig / gbk / binary / unknown，绝不用 `errors='replace'` 生成可写回内容。

> **安全策略：** 某些 UTF-8 中文字节也能被 GBK 严格解码，无法可靠地自动区分。此类“UTF-8/GBK 双可解”文件会标记为“待复核”，插件不会自动转码或写回，避免把原本正常显示的中文变成乱码。请在 VS Code 中确认其实际编码后再单独处理。
