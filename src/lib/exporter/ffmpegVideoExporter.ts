// src/lib/exporter/ffmpegVideoExporter.ts

import type * as PIXI from 'pixi.js';

// ─── 类型定义 ─────────────────────────────────────────────────
export interface FfmpegExportOptions {
  /** PixiJS Application 实例（用于触发帧渲染） */
  pixiApp: PIXI.Application;
  /** 源视频元素 */
  video: HTMLVideoElement;
  /** PixiJS 渲染目标 Canvas */
  canvas: HTMLCanvasElement;
  /** 导出帧率（建议 30） */
  fps?: number;
  /** 输出文件路径（主进程路径，如 /Users/xxx/Desktop/output.mp4） */
  outputPath: string;
  /** 源音频路径（可选，用于保留原始音轨） */
  audioPath?: string;
  /** 画质（CRF）: 0=无损 18=高质 23=默认 */
  crf?: number;
  /** 编码预设: ultrafast/fast/medium/slow */
  preset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
  /** 是否使用硬件加速 */
  useHwAccel?: boolean;
  /** 进度回调，参数为 0~1 */
  onProgress?: (progress: number) => void;
  /** 取消信号（返回 true 表示需要取消） */
  cancelSignal?: () => boolean;
}

export interface FfmpegExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  totalFrames: number;
  durationMs: number;
}

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * 精确 seek 视频到指定时间戳，并等待 seeked 事件（帧已解码）
 */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      // seek 超时不报错，直接继续（部分格式 seek 较慢）
      console.warn(`[FfmpegExporter] seek 到 ${time.toFixed(3)}s 超时，继续处理`);
      resolve();
    }, 3000); // 3秒超时

    const onSeeked = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };

    video.addEventListener('seeked', onSeeked, { once: true });

    // 触发 seek
    if (Math.abs(video.currentTime - time) < 0.001) {
      // 已经在目标位置，直接 resolve
      clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    } else {
      video.currentTime = time;
    }
  });
}

/**
 * 让出主线程，防止渲染进程 UI 冻结
 * 使用 MessageChannel 比 setTimeout(0) 延迟更低
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof globalThis !== 'undefined' &&
      'scheduler' in globalThis &&
      typeof (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler?.yield === 'function'
    ) {
      (globalThis as { scheduler: { yield: () => Promise<void> } }).scheduler.yield().then(resolve);
    } else {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(undefined);
    }
  });
}

// ─── 辅助：垂直翻转像素数组（WebGL 坐标修正） ─────────────────
function flipVertically(
  pixels: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const rowSize = width * 4;
  const flipped = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    const srcOffset = (height - 1 - y) * rowSize;
    const dstOffset = y * rowSize;
    flipped.set(pixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
  }
  return flipped;
}

// ─── 主导出函数 ───────────────────────────────────────────────

/**
 * 高速 FFmpeg 导出（Electron 主进程渲染管线）
 *
 * 导出流程：
 * 1. 暂停 PixiJS 自动渲染循环
 * 2. 启动主进程 FFmpeg 会话
 * 3. 逐帧 seek → 渲染 → getImageData → IPC 推帧
 * 4. 结束 FFmpeg 会话，等待编码完成
 * 5. 恢复 PixiJS 渲染循环
 */
export async function exportWithFfmpeg(
  options: FfmpegExportOptions
): Promise<FfmpegExportResult> {
  const {
    pixiApp,
    video,
    canvas,
    fps = 30,
    outputPath,
    audioPath,
    crf = 18,
    preset = 'fast',
    useHwAccel = false,
    onProgress,
    cancelSignal,
  } = options;

  const startTime = performance.now();
  const duration = video.duration;
  const frameInterval = 1 / fps;
  const totalFrames = Math.ceil(duration * fps);

  console.log(
    `[FfmpegExporter] 开始导出: ${totalFrames} 帧, ${duration.toFixed(2)}s, ${fps}fps → ${outputPath}`
  );

  // ── 获取 2D 上下文用于 getImageData ──────────────────────
  // 注意：PixiJS 默认使用 WebGL 渲染器，Canvas 内容需要通过以下方式获取
  // 如果你的 PixiJS 使用 CanvasRenderer，可以直接 canvas.getContext('2d')
  const ctx = canvas.getContext('2d');

  // ── 暂停 PixiJS 自动渲染 ─────────────────────────────────
  const wasRunning = pixiApp.ticker.started;
  pixiApp.ticker.stop();
  video.pause();

  let unsubscribeDone: (() => void) | null = null;

  try {
    // ── 注册完成事件监听 ─────────────────────────────────────
    const exportDonePromise = new Promise<{ success: boolean; outputPath?: string; error?: string }>(
      (resolve) => {
        unsubscribeDone = window.electronAPI.ffmpegExport.onDone(resolve);
      }
    );

    // ── 启动 FFmpeg 主进程会话 ────────────────────────────────
    const startResult = await window.electronAPI.ffmpegExport.start({
      outputPath,
      width: canvas.width,
      height: canvas.height,
      fps,
      audioPath,
      crf,
      preset,
      useHwAccel,
    });

    if (!startResult.ok) {
      throw new Error(`启动 FFmpeg 失败: ${startResult.error}`);
    }

    // ── 逐帧渲染主循环 ────────────────────────────────────────
    for (let frame = 0; frame < totalFrames; frame++) {
      // 检查取消信号
      if (cancelSignal?.()) {
        console.log('[FfmpegExporter] 用户取消导出');
        await window.electronAPI.ffmpegExport.cancel();
        return {
          success: false,
          error: '用户取消',
          totalFrames: frame,
          durationMs: performance.now() - startTime,
        };
      }

      // 计算当前帧时间戳（确保不超过视频时长）
      const t = Math.min(frame * frameInterval, duration - 0.001);

      // Step 1: Seek 视频到精确时间戳
      await seekTo(video, t);

      // Step 2: 触发 PixiJS 单帧渲染
      // 注意：需要根据你的 PixiJS 版本和使用方式调整
      pixiApp.ticker.update(t * 1000); // 传入毫秒时间戳，保证动画/缩放在正确时间点计算
      pixiApp.renderer.render(pixiApp.stage);

      // Step 3: 从 Canvas 读取像素数据
      let frameBuffer: ArrayBuffer;

      if (ctx) {
        // CanvasRenderer：直接从 2D context 读取
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        frameBuffer = imageData.data.buffer;
      } else {
        // WebGL Renderer：从 WebGL context 读取
        const gl = (canvas.getContext('webgl') as WebGLRenderingContext) ?? (canvas.getContext('webgl2') as WebGL2RenderingContext);
        if (!gl) throw new Error('无法获取 Canvas 渲染上下文');

        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(
          0, 0,
          canvas.width,
          canvas.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels
        );

        // WebGL Y 轴与 Canvas 相反，需要翻转
        frameBuffer = flipVertically(pixels, canvas.width, canvas.height).buffer;
      }

      // Step 4: 通过 IPC 将帧数据推送给主进程 FFmpeg
      const pushResult = await window.electronAPI.ffmpegExport.pushFrame(frameBuffer);
      if (!pushResult.ok) {
        throw new Error(`推帧失败 (frame ${frame}): ${pushResult.error}`);
      }

      // Step 5: 进度回调
      onProgress?.((frame + 1) / totalFrames);

      // Step 6: 每 30 帧让出主线程一次，避免 UI 完全冻结
      if (frame % 30 === 0) {
        await yieldToMain();
      }
    }

    console.log(`[FfmpegExporter] 所有帧推送完毕，等待 FFmpeg 编码完成...`);

    // ── 通知 FFmpeg 输入结束 ──────────────────────────────────
    await window.electronAPI.ffmpegExport.finish();

    // ── 等待 FFmpeg 编码完成 ──────────────────────────────────
    const result = await exportDonePromise;
    const durationMs = performance.now() - startTime;

    if (result.success) {
      const speedMultiple = (duration / (durationMs / 1000)).toFixed(1);
      console.log(
        `[FfmpegExporter] 导出完成！耗时 ${(durationMs / 1000).toFixed(1)}s，` +
          `速度约 ${speedMultiple}x 实时速度`
      );
    }

    return {
      success: result.success,
      outputPath: result.outputPath,
      error: result.error,
      totalFrames,
      durationMs,
    };
  } finally {
    // ── 清理：恢复 PixiJS 渲染循环 ───────────────────────────
    if (wasRunning) {
      pixiApp.ticker.start();
    }
    unsubscribeDone?.();
  }
}
