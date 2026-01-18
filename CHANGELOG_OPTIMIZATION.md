# OpenScreen 中文版 优化更新日志

## 版本 1.3.4 (优化版)

### 主要更新

#### 1. 移除 AI API 功能
- 移除了 SmartZoom (智能缩放) 功能，该功能需要配置 Gemini API Key
- 移除了 AI 图片生成功能，该功能需要配置 Gemini API Key
- 删除了 `src/lib/smartZoom/` 和 `src/lib/imageGen/` 目录
- 清理了相关的国际化文本

#### 2. 集成自动更新机制
- 新增 `electron/updater.ts` 模块，使用 electron-updater 实现自动更新
- 配置了 GitHub Releases 作为更新源
- 实现了完整的更新流程：检测 -> 下载 -> 提示重启 -> 完成更新
- 更新过程中显示下载进度条

#### 3. 优化错误处理和用户反馈
- 新增 `src/lib/errorHandler.ts` 统一错误处理工具
- 将底层错误转化为用户友好的中文提示
- 录制过程中的错误会以 Toast 形式展示给用户
- 音频设备不可用时会给出明确提示，而非静默失败

#### 4. 清理调试代码
- 移除了所有 `console.log` 和 `console.warn` 语句
- 保留了必要的 `console.error` 用于错误追踪
- 代码更加整洁，生产环境不会输出调试信息

#### 5. 优化单实例管理
- 移除了粗暴的 `taskkill` 进程杀死逻辑
- 改用 Electron 原生的 `requestSingleInstanceLock` 机制
- 当第二个实例启动时，会自动激活已有窗口

#### 6. 国际化完善
- 完善了导出对话框的中文翻译
- 添加了导出相关的翻译文本

### 技术细节

**新增依赖：**
- `electron-updater`: ^6.1.7

**删除的文件：**
- `src/lib/smartZoom/smartZoomAnalyzer.ts`
- `src/lib/imageGen/imagenService.ts`
- `src/components/video-editor/SmartZoomPanel.tsx`

**修改的文件：**
- `package.json` - 添加 electron-updater 依赖
- `electron-builder.json5` - 添加 GitHub publish 配置
- `electron/main.ts` - 集成自动更新，优化单实例管理
- `electron/updater.ts` - 新增自动更新模块
- `src/lib/errorHandler.ts` - 新增统一错误处理
- `src/hooks/useScreenRecorder.ts` - 优化错误处理
- `src/components/video-editor/ExportDialog.tsx` - 完善国际化
- `src/components/video-editor/SettingsPanel.tsx` - 移除 SmartZoom
- `src/components/video-editor/VideoEditor.tsx` - 移除 SmartZoom
- `src/components/video-editor/AnnotationSettingsPanel.tsx` - 移除 AI 图片生成
- `src/locales/zh.json` - 添加导出翻译，移除 AI 相关翻译
- `src/locales/en.json` - 移除 AI 相关翻译

### 使用说明

1. **自动更新**：应用启动后会自动检查更新，发现新版本时会提示用户下载

2. **发布新版本**：
   - 更新 `package.json` 中的版本号
   - 运行 `pnpm build:win` 构建 Windows 版本
   - 将生成的安装包上传到 GitHub Releases
   - 用户端会自动检测到新版本

3. **错误反馈**：录制或导出过程中遇到问题时，会以 Toast 形式展示错误信息
