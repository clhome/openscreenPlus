# FFmpeg 高速导出优化任务清单

根据 `文档/openscreenPlus_ffmpeg_export_optimization优化方案260404.md` 进行系统优化，提升导出速度。

## 任务列表

- [x] 1. 安装 FFmpeg 相关依赖 `ffmpeg-static`, `fluent-ffmpeg` <!-- id: 0 -->
- [x] 2. 修改 `electron-builder.json5` 配置，处理 ffmpeg 二进制解压 <!-- id: 1 -->
- [x] 3. 新增 `electron/ffmpegExport.ts` 处理主进程 FFmpeg 管线 <!-- id: 2 -->
- [x] 4. 修改 `electron/main.ts` 注册所有相关的 IPC 通道 <!-- id: 3 -->
- [x] 5. 修改 `electron/preload.ts` 暴露 FFmpeg 导出 API <!-- id: 4 -->
- [x] 6. 新增 `src/lib/exporter/ffmpegVideoExporter.ts` 实现逐帧渲染推送逻辑 <!-- id: 5 -->
- [x] 7. 修改 `src/lib/exporter/videoExporter.ts` 接入新导出器并保留备份 <!-- id: 6 -->
- [x] 8. 修改 `vite.config.ts` 以正确处理 Node.js 模块 <!-- id: 7 -->
- [x] 9. 测试与验证 <!-- id: 8 -->

---
最新需求补充于 2026-04-04 17:23

## 二次优化任务 (2026-04-04 18:52)

### 问题诊断
1. 导出画面上下颠倒
2. 导出速度极慢 (speed 0.3-0.4x)
3. 无音频

### 任务列表

- [x] 10. 音频支持：将源视频路径传给 FFmpeg 作为第二输入提取音轨 <!-- id: 10 -->
- [x] 11. 修复 file:// URL 协议转换（FFmpeg 不识别 file:/// 格式） <!-- id: 11 -->
- [x] 12. GPU 自动检测：PowerShell 扫描显卡，分 NVIDIA/AMD/Intel/CPU 选择编码器 <!-- id: 12 -->
- [x] 13. 修复画面颠倒：移除错误的 `-vf vflip`（compositeCanvas 是 2D canvas，不需要翻转） <!-- id: 13 -->
- [x] 14. 速度优化：将逐帧 Seek 替换为顺序播放 + requestVideoFrameCallback <!-- id: 14 -->
- [x] 15. 修复导出完成卡死：添加 video `ended` 事件监听 + 超时保护 <!-- id: 15 -->
- [x] 16. 架构改造：新增纯 FFmpeg 快速路径（无 Zoom/Annotation 时，10-20x 速度） <!-- id: 16 -->
- [x] 17. 在 main.ts/preload.ts 注册 `ffmpeg:fast-export` IPC 通道 <!-- id: 17 -->
- [x] 18. 更新 electron-env.d.ts TypeScript 类型定义 <!-- id: 18 -->
- [x] 19. 极致体验优化：加入“录制后闪电混流（Remux）”方案，自动将 WebM 转封装为 MP4 以彻底解决编辑器拖拽卡顿问题。 <!-- id: 19 -->
- [ ] 20. 验证导出：画面、音频、拖拽进度条和导出速度体验 <!-- id: 20 -->
