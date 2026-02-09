# GitHub Actions 自动化部署指南

本文档详细介绍如何使用 GitHub Actions 自动化构建 OpenScreenPlus 并发布到 GitHub Releases。

---

## 📋 目录

1. [概述](#概述)
2. [前置条件](#前置条件)
3. [配置步骤](#配置步骤)
4. [工作流文件详解](#工作流文件详解)
5. [使用方法](#使用方法)
6. [常见问题](#常见问题)

---

## 概述

GitHub Actions 可以在你创建新的 Tag 或 Release 时，自动：

- ✅ 构建 Windows (.exe) 安装包
- ✅ 构建 macOS (.dmg) 安装包
- ✅ 构建 Linux (.AppImage) 安装包
- ✅ 自动打包源代码
- ✅ 自动上传所有产物到 GitHub Releases

---

## 前置条件

### 1. 确保项目配置正确

你的 `package.json` 应该包含以下构建脚本：

```json
{
  "scripts": {
    "build:mac": "tsc && vite build && electron-builder --mac",
    "build:win": "tsc && vite build && electron-builder --win",
    "build:linux": "tsc && vite build && electron-builder --linux"
  }
}
```

### 2. 确保 `electron-builder.json5` 配置正确

```json5
{
  appId: "com.openscreenplus.app",
  productName: "OpenScreenPlus",
  directories: {
    output: "release",
  },
  files: ["dist", "dist-electron", "package.json"],
  win: {
    icon: "icons/icons/win/icon.ico",
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
  },
  mac: {
    icon: "icons/icons/mac/icon.icns",
    target: ["dmg"],
  },
  linux: {
    icon: "icons/icons/png",
    target: ["AppImage"],
  },
}
```

---

## 配置步骤

### 步骤 1：创建 Release 工作流文件

在项目根目录创建 `.github/workflows/release.yml` 文件：

```yaml
name: Build and Release

on:
  push:
    tags:
      - "v*" # 当推送 v 开头的 tag 时触发，例如 v1.0.0

permissions:
  contents: write

jobs:
  # ============================
  # Windows 构建任务
  # ============================
  build-windows:
    runs-on: windows-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Install app dependencies
        run: npx electron-builder install-app-deps

      - name: Build Windows app
        run: npm run build:win
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload Windows artifacts
        uses: actions/upload-artifact@v4
        with:
          name: windows-build
          path: |
            release/*.exe
            release/*.exe.blockmap
          retention-days: 1

  # ============================
  # macOS 构建任务
  # ============================
  build-macos:
    runs-on: macos-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Setup Python (for node-gyp)
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install dependencies
        run: npm ci

      - name: Install app dependencies
        run: npx electron-builder install-app-deps

      - name: Build macOS app
        run: npm run build:mac
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload macOS artifacts
        uses: actions/upload-artifact@v4
        with:
          name: macos-build
          path: |
            release/*.dmg
            release/*.dmg.blockmap
          retention-days: 1

  # ============================
  # Linux 构建任务
  # ============================
  build-linux:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Install app dependencies
        run: npx electron-builder install-app-deps

      - name: Build Linux app
        run: npm run build:linux
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload Linux artifacts
        uses: actions/upload-artifact@v4
        with:
          name: linux-build
          path: release/*.AppImage
          retention-days: 1

  # ============================
  # 创建 Release 并上传产物
  # ============================
  release:
    needs: [build-windows, build-macos, build-linux]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts

      - name: Display structure of downloaded files
        run: ls -R artifacts

      - name: Get version from tag
        id: get_version
        run: echo "VERSION=${GITHUB_REF#refs/tags/}" >> $GITHUB_OUTPUT

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          name: OpenScreenPlus ${{ steps.get_version.outputs.VERSION }}
          body: |
            ## 🎉 OpenScreenPlus ${{ steps.get_version.outputs.VERSION }}

            ### 📦 下载

            | 平台 | 下载链接 |
            |------|----------|
            | Windows | `.exe` 安装包 |
            | macOS | `.dmg` 安装包 |
            | Linux | `.AppImage` 文件 |

            ### 📝 更新日志

            请查看 [CHANGELOG](https://github.com/${{ github.repository }}/blob/main/CHANGELOG.md) 了解详细更新内容。

            ---

            **完整更新日志**: https://github.com/${{ github.repository }}/compare/...v${{ steps.get_version.outputs.VERSION }}
          draft: false
          prerelease: false
          generate_release_notes: true
          files: |
            artifacts/windows-build/*
            artifacts/macos-build/*
            artifacts/linux-build/*
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 步骤 2：配置 GitHub 仓库权限

1. 进入你的 GitHub 仓库
2. 点击 **Settings** → **Actions** → **General**
3. 滚动到 **Workflow permissions** 部分
4. 选择 **Read and write permissions**
5. 勾选 **Allow GitHub Actions to create and approve pull requests**（可选）
6. 点击 **Save**

![Workflow Permissions](https://docs.github.com/assets/cb-28196/images/help/repository/actions-workflow-permissions-repository.png)

### 步骤 3：提交工作流文件

```bash
# 添加工作流文件
git add .github/workflows/release.yml

# 提交更改
git commit -m "feat: add GitHub Actions release workflow"

# 推送到远程仓库
git push origin main
```

---

## 工作流文件详解

### 触发条件

```yaml
on:
  push:
    tags:
      - "v*"
```

当你推送以 `v` 开头的 tag 时，工作流会自动触发。例如：

- `v1.0.0`
- `v1.0.1-beta`
- `v2.0.0-rc.1`

### 构建任务

工作流包含三个并行的构建任务：

| 任务            | 运行环境         | 输出产物         |
| --------------- | ---------------- | ---------------- |
| `build-windows` | `windows-latest` | `.exe` 安装包    |
| `build-macos`   | `macos-latest`   | `.dmg` 安装包    |
| `build-linux`   | `ubuntu-latest`  | `.AppImage` 文件 |

### Release 任务

`release` 任务在所有构建任务完成后执行：

1. 下载所有构建产物
2. 创建 GitHub Release
3. 上传所有产物和源代码到 Release

---

## 使用方法

### 方法 1：通过命令行创建 Release

```bash
# 1. 确保代码已提交
git add .
git commit -m "feat: your commit message"

# 2. 更新 package.json 中的版本号
# 例如将 "version": "1.0.0" 改为 "version": "1.1.0"

# 3. 提交版本更新
git add package.json
git commit -m "chore: bump version to v1.1.0"

# 4. 创建 Git Tag
git tag v1.1.0

# 5. 推送代码和 Tag
git push origin main
git push origin v1.1.0
```

### 方法 2：使用 npm version 自动化

```bash
# 自动更新版本号、创建 commit 和 tag
npm version patch  # 1.0.0 → 1.0.1
npm version minor  # 1.0.0 → 1.1.0
npm version major  # 1.0.0 → 2.0.0

# 推送代码和 Tag
git push origin main --tags
```

### 方法 3：通过 GitHub 网页界面

1. 进入仓库的 **Releases** 页面
2. 点击 **Draft a new release**
3. 点击 **Choose a tag**
4. 输入新的 tag 名称（例如 `v1.1.0`）
5. 点击 **Create new tag: v1.1.0 on publish**
6. 填写 Release 标题和描述
7. 点击 **Publish release**

> ⚠️ **注意**：这种方法会先创建 Release，然后 GitHub Actions 会自动构建并上传产物。

---

## 监控构建进度

1. 进入仓库的 **Actions** 标签页
2. 查看正在运行的工作流
3. 点击工作流可以查看详细日志

构建完成后，产物会自动上传到对应的 Release 页面。

---

## 高级配置

### 添加代码签名（可选）

#### Windows 代码签名

```yaml
- name: Build Windows app
  run: npm run build:win
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
    CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
```

#### macOS 代码签名和公证

```yaml
- name: Build macOS app
  run: npm run build:mac
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    CSC_LINK: ${{ secrets.MAC_CSC_LINK }}
    CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

### 添加自动更新支持（可选）

在 `electron-builder.json5` 中添加：

```json5
{
  // ... 其他配置
  publish: {
    provider: "github",
    owner: "YOUR_GITHUB_USERNAME",
    repo: "openscreenPlus",
  },
}
```

### 只构建特定平台（可选）

如果你只需要 Windows 版本，可以创建简化版工作流：

```yaml
name: Build Windows Only

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write

jobs:
  build-and-release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build Windows app
        run: npm run build:win
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          files: release/*.exe
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 常见问题

### Q1: 构建失败，提示权限不足怎么办？

确保已在仓库设置中启用 **Read and write permissions**：

- Settings → Actions → General → Workflow permissions

### Q2: macOS 构建失败，提示 node-gyp 错误怎么办？

确保工作流中包含 Python 安装步骤：

```yaml
- name: Setup Python
  uses: actions/setup-python@v5
  with:
    python-version: "3.11"
```

### Q3: 如何添加更多构建产物格式？

修改 `electron-builder.json5`：

```json5
{
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] }, // 便携版
      { target: "zip", arch: ["x64"] }, // ZIP 打包
    ],
  },
}
```

### Q4: 如何只在特定分支创建 Release？

```yaml
on:
  push:
    tags:
      - "v*"
    branches:
      - main # 只有 main 分支的 tag 才触发
```

### Q5: 如何创建预发布版本？

使用 `-beta`、`-alpha` 或 `-rc` 后缀的 tag：

```bash
git tag v1.0.0-beta.1
git push origin v1.0.0-beta.1
```

在工作流中自动检测并标记为预发布：

```yaml
- name: Create Release
  uses: softprops/action-gh-release@v1
  with:
    prerelease: ${{ contains(github.ref, '-beta') || contains(github.ref, '-alpha') || contains(github.ref, '-rc') }}
```

### Q6: 构建产物太大，上传失败怎么办？

GitHub Release 单个文件最大 2GB。如果产物过大，考虑：

1. 使用 `nsis-web` 替代 `nsis` 来创建网络安装包
2. 启用 `asar` 打包压缩
3. 排除不必要的 `node_modules`

---

## 总结

完成上述配置后，你的发布流程将变成：

```
开发完成 → 更新版本号 → 创建 Tag → 推送 → 自动构建 → 自动发布
```

GitHub Actions 会自动处理所有构建和发布工作，你只需要关注代码开发即可！

---

## 相关链接

- [GitHub Actions 文档](https://docs.github.com/cn/actions)
- [electron-builder 文档](https://www.electron.build/)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release)
