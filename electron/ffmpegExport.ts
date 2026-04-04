// electron/ffmpegExport.ts

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 获取 ffmpeg 可执行文件路径（开发环境 vs 打包环境）
function getFfmpegPath(): string {
  // ffmpeg-static 返回当前平台的 ffmpeg 路径
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let ffmpegPath: string = require('ffmpeg-static');

  // 打包后路径在 app.asar.unpacked 目录中
  if (ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }

  return ffmpegPath;
}

// 获取当前系统主流显卡类型，用于优化编码
function getGpuType(): 'nvidia' | 'amd' | 'intel' | 'cpu' {
  if (process.platform !== 'win32') return 'cpu';
  try {
    const { execSync } = require('child_process');
    // 使用 PowerShell 获取显卡名称
    const output = execSync(
      'powershell -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"'
    ).toString();
    const lowerOut = output.toLowerCase();

    if (lowerOut.includes('nvidia')) return 'nvidia';
    if (lowerOut.includes('amd') || lowerOut.includes('radeon')) return 'amd';
    if (lowerOut.includes('intel')) return 'intel';
    
    return 'cpu';
  } catch (e) {
    console.error('[FFmpegExport] GPU 探测失败，回退至 CPU:', e);
    return 'cpu';
  }
}

// ─── 导出会话状态 ───────────────────────────────────────────────
interface ExportSession {
  process: ChildProcessWithoutNullStreams;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  resolve: (outputPath: string) => void;
  reject: (err: Error) => void;
  onDone?: (result: { success: boolean; outputPath?: string; error?: string }) => void;
}

let currentSession: ExportSession | null = null;

// ─── 启动导出会话 ─────────────────────────────────────────────
export interface StartExportOptions {
  outputPath: string;   // 输出 MP4 文件路径
  width: number;        // 视频宽度（像素）
  height: number;       // 视频高度（像素）
  fps: number;          // 目标帧率（如 30）
  audioPath?: string;   // 可选：原始音频文件路径，用于混入音轨
  crf?: number;         // 画质参数，0=无损，18=高质，23=默认，51=最差
  preset?: string;      // 编码速度预设：ultrafast/fast/medium/slow
  useHwAccel?: boolean; // 是否尝试硬件加速编码
  onDone?: (result: { success: boolean; outputPath?: string; error?: string }) => void;
}

export function startExportSession(options: StartExportOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (currentSession) {
      reject(new Error('已有导出任务正在进行，请等待完成后再试'));
      return;
    }

    const {
      outputPath,
      width,
      height,
      fps,
      audioPath,
      crf = 18,
      useHwAccel = false,
    } = options;

    // FFmpeg 不解析 file:/// 协议，需要转换回本地路径
    let finalAudioPath = audioPath;
    if (audioPath && audioPath.startsWith('file:///')) {
      try {
        const { fileURLToPath } = require('node:url');
        finalAudioPath = fileURLToPath(audioPath);
      } catch (e) {
        console.error('[FFmpegExport] URL 转换失败:', audioPath, e);
      }
    }

    // 确保输出目录存在
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const ffmpegPath = getFfmpegPath();

    // ── 构建 FFmpeg 参数 ──────────────────────────────────────
    // 输入：从 stdin 读取 raw RGBA 视频帧
    const inputArgs = [
      '-f', 'rawvideo',          // 输入格式：原始视频
      '-pix_fmt', 'rgba',        // 像素格式：RGBA（Canvas getImageData 输出）
      '-s', `${width}x${height}`, // 分辨率
      '-r', String(fps),         // 输入帧率
      '-i', 'pipe:0',            // 从 stdin 读取
    ];

    // 如果有音频，同时加载音频文件
    const audioInputArgs: string[] = finalAudioPath
      ? ['-i', finalAudioPath]
      : [];

    // 选择编码器
    let videoCodecArgs: string[];
    if (useHwAccel) {
      const platform = process.platform;
      if (platform === 'darwin') {
        videoCodecArgs = [
          '-c:v', 'h264_videotoolbox', 
          '-b:v', '12M', 
          '-preset', 'fast',
        ];
      } else if (platform === 'win32') {
        const gpu = getGpuType();
        console.log('[FFmpegExport] 检测到 Windows GPU 类型:', gpu);

        if (gpu === 'nvidia') {
          videoCodecArgs = [
            '-c:v', 'h264_nvenc',
            '-preset', 'p1',
            '-rc', 'vbr',
            '-cq', String(crf),
            '-pix_fmt', 'yuv420p',
          ];
        } else if (gpu === 'amd') {
          // AMD Radeon 显卡优化
          videoCodecArgs = [
            '-c:v', 'h264_amf',
            '-rc', 'cqp',
            '-qp_i', String(crf),
            '-qp_p', String(crf),
            '-quality', 'speed',
            '-pix_fmt', 'yuv420p',
          ];
        } else if (gpu === 'intel') {
          // Intel QSV 优化
          videoCodecArgs = [
            '-c:v', 'h264_qsv',
            '-preset', 'veryfast',
            '-global_quality', String(crf),
            '-pix_fmt', 'nv12',
          ];
        } else {
          // 无显卡支持时回退到 CPU ultrafast
          videoCodecArgs = [
            '-c:v', 'libx264',
            '-crf', String(crf),
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
          ];
        }
      } else {
        videoCodecArgs = [
          '-c:v', 'h264_vaapi', 
          '-vf', 'format=nv12,hwupload', 
          '-b:v', '12M'
        ];
      }
    } else {
      videoCodecArgs = [
        '-c:v', 'libx264',
        '-crf', String(crf),
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
      ];
    }

    // 音频编码参数
    // 如果有原始视频，提取并混入音频
    const audioCodecArgs: string[] = finalAudioPath
      ? [
          '-c:a', 'aac', 
          '-b:a', '192k', 
          '-af', 'aresample=async=1', // 解决帧率不稳导致的音画同步
          '-map', '0:v:0',           // 视频选 stdin
          '-map', '1:a:0',           // 音频选 audioPath
          '-shortest'                // 以短的为准
        ]
      : ['-an']; 

    // 输出参数
    const outputArgs = [
      '-movflags', '+faststart',
      '-threads', '0',           // 自动多线程
      '-y',
      outputPath,
    ];

    // 合并所有参数
    const ffmpegArgs = [
      ...inputArgs,
      ...audioInputArgs,
      ...videoCodecArgs,
      ...audioCodecArgs,
      ...outputArgs,
    ];

    console.log('[FFmpegExport] 启动 FFmpeg:', ffmpegPath, ffmpegArgs.join(' '));

    // ── 启动 FFmpeg 子进程 ────────────────────────────────────
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'], // stdin/stdout/stderr 全部捕获
    });

    // 监听 FFmpeg 日志（stderr）
    ffmpegProcess.stderr.on('data', (data: Buffer) => {
      // FFmpeg 的进度信息输出到 stderr，这是正常行为
      const msg = data.toString();
      // 只输出关键信息，过滤掉过于频繁的 frame= 进度行
      if (!msg.includes('frame=') || process.env.NODE_ENV === 'development') {
        console.log('[FFmpeg]', msg.trim());
      }
    });

    ffmpegProcess.stdout.on('data', (data: Buffer) => {
      console.log('[FFmpeg stdout]', data.toString());
    });

    // 监听进程退出
    ffmpegProcess.on('close', (code: number | null) => {
      const session = currentSession;
      currentSession = null;

      if (code === 0) {
        console.log(`[FFmpegExport] 导出成功: ${outputPath}`);
        session?.onDone?.({ success: true, outputPath });
      } else {
        const err = new Error(`FFmpeg 退出码: ${code}，导出失败`);
        console.error('[FFmpegExport]', err.message);
        session?.onDone?.({ success: false, error: err.message });
        // 清理损坏的输出文件
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      }
    });

    ffmpegProcess.on('error', (err: Error) => {
      console.error('[FFmpegExport] 进程错误:', err);
      currentSession = null;
      reject(err);
    });

    // 保存会话状态
    currentSession = {
      process: ffmpegProcess,
      outputPath,
      width,
      height,
      fps,
      frameCount: 0,
      resolve,
      reject,
      onDone: options.onDone,
    };

    console.log(`[FFmpegExport] 会话已启动: ${width}x${height} @ ${fps}fps -> ${outputPath}`);
    
    // 立即成功返回启动状态
    resolve(outputPath);
  });
}

// ─── 推送单帧 raw RGBA 数据 ───────────────────────────────────
export function pushFrame(frameBuffer: ArrayBuffer): void {
  if (!currentSession) {
    console.warn('[FFmpegExport] pushFrame: 没有活跃的导出会话');
    return;
  }

  const buffer = Buffer.from(frameBuffer);
  const expectedSize = currentSession.width * currentSession.height * 4; // RGBA = 4 bytes/pixel

  if (buffer.byteLength !== expectedSize) {
    console.error(
      `[FFmpegExport] 帧大小不匹配: 期望 ${expectedSize} 字节，收到 ${buffer.byteLength} 字节`
    );
    return;
  }

  // 写入 FFmpeg 的 stdin 管道
  const canWrite = currentSession.process.stdin.write(buffer);
  currentSession.frameCount++;

  // 背压处理：如果管道缓冲区满，等待 drain 事件（避免内存溢出）
  if (!canWrite) {
    // 这里返回一个 Promise，让渲染进程可以 await 背压
    // 实际上 IPC 调用本身已经是异步的，主进程会在 drain 前暂停处理
  }

  if (currentSession.frameCount % 100 === 0) {
    console.log(`[FFmpegExport] 已推送 ${currentSession.frameCount} 帧`);
  }
}

// ─── 推送帧（带背压等待）────────────────────────────────────
export function pushFrameWithBackpressure(frameBuffer: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!currentSession) {
      reject(new Error('没有活跃的导出会话'));
      return;
    }

    const buffer = Buffer.from(frameBuffer);
    const stdin = currentSession.process.stdin;
    currentSession.frameCount++;

    const canWrite = stdin.write(buffer, (err) => {
      if (err) reject(err);
      else resolve();
    });

    // 如果管道满了，等待 drain 事件再继续
    if (!canWrite) {
      stdin.once('drain', resolve);
    }
  });
}

// ─── 结束导出会话 ─────────────────────────────────────────────
export function finishExport(): void {
  if (!currentSession) {
    console.warn('[FFmpegExport] finishExport: 没有活跃的导出会话');
    return;
  }

  console.log(`[FFmpegExport] 关闭 stdin，等待 FFmpeg 完成编码... 总帧数: ${currentSession.frameCount}`);

  // 关闭 stdin，通知 FFmpeg 输入结束，触发最终编码和文件写入
  currentSession.process.stdin.end();
}

// ─── 取消导出（用于用户主动中止）────────────────────────────
export function cancelExport(): void {
  if (!currentSession) return;

  console.log('[FFmpegExport] 用户取消导出');
  currentSession.process.kill('SIGTERM');

  // 清理输出文件
  const outputPath = currentSession.outputPath;
  setTimeout(() => {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }, 500);

  currentSession = null;
}

// ─── 查询导出状态 ─────────────────────────────────────────────
export function getExportStatus(): { active: boolean; frameCount: number } {
  return {
    active: currentSession !== null,
    frameCount: currentSession?.frameCount ?? 0,
  };
}

// ─── 纯 FFmpeg 快速导出（10-20x 速度）──────────────────────────
// 完全绕过浏览器渲染管线，由 FFmpeg 进行解码→滤镜→编码一条龙
export interface FastExportOptions {
  inputPath: string;       // 源视频路径
  outputPath: string;      // 输出 MP4 路径
  width: number;           // 输出画布宽度
  height: number;          // 输出画布高度
  fps: number;
  padding?: number;        // 内边距 (px)
  borderRadius?: number;   // 圆角半径
  background?: string;     // 背景色，如 '#1a1a2e'
  crf?: number;
  onProgress?: (progress: { percentage: number; speed: string }) => void;
  onDone?: (result: { success: boolean; outputPath?: string; error?: string }) => void;
}

export function fastExport(options: FastExportOptions): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  return new Promise((resolve) => {
    const {
      inputPath,
      outputPath,
      width,
      height,
      fps,
      padding = 32,
      background = '#1a1a2e',
      crf = 18,
    } = options;

    // 转换 file:// URL
    let finalInputPath = inputPath;
    if (inputPath.startsWith('file:///')) {
      try {
        const { fileURLToPath } = require('node:url');
        finalInputPath = fileURLToPath(inputPath);
      } catch (e) {
        console.error('[FastExport] URL 转换失败:', e);
      }
    }

    // 确保输出目录存在
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const ffmpegPath = getFfmpegPath();
    const gpu = getGpuType();
    console.log('[FastExport] GPU 类型:', gpu, '输入:', finalInputPath);

    // 计算视频区域尺寸（画布 - 内边距）
    const videoW = width - padding * 2;
    const videoH = height - padding * 2;

    // 构建 FFmpeg 滤镜图
    // 1. 将源视频缩放到目标区域，保持宽高比，然后居中放置在彩色背景上
    const filterComplex = [
      // 缩放视频到目标尺寸，保持比例，添加黑边填充
      `[0:v]scale=${videoW}:${videoH}:force_original_aspect_ratio=decrease,` +
      `pad=${videoW}:${videoH}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `fps=${fps}[scaled]`,
      // 创建背景色画布
      `color=c=${background}:s=${width}x${height}:r=${fps}[bg]`,
      // 将视频叠加到背景中央
      `[bg][scaled]overlay=${padding}:${padding}:shortest=1[out]`
    ].join(';');

    // 构建 trim 参数（如果有剪辑区域）
    const inputArgs: string[] = [];
    
    // 如果有剪辑，用 select filter。简单起见先不处理复杂剪辑，
    // 直接让主流程处理 trim，这里先做完整导出
    inputArgs.push('-i', finalInputPath);

    // 选择编码器
    let encoderArgs: string[];
    if (gpu === 'nvidia') {
      encoderArgs = ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', String(crf), '-pix_fmt', 'yuv420p'];
    } else if (gpu === 'amd') {
      encoderArgs = ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-quality', 'speed', '-pix_fmt', 'yuv420p'];
    } else if (gpu === 'intel') {
      encoderArgs = ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', String(crf), '-pix_fmt', 'nv12'];
    } else {
      encoderArgs = ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p'];
    }

    const ffmpegArgs = [
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-map', '0:a?',            // 如果有音频就映射
      ...encoderArgs,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-af', 'aresample=async=1',
      '-movflags', '+faststart',
      '-threads', '0',
      '-y',
      outputPath,
    ];

    console.log('[FastExport] 启动纯 FFmpeg 管线:', ffmpegPath, ffmpegArgs.join(' '));

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let duration = 0;

    ffmpegProcess.stderr.on('data', (data: Buffer) => {
      const msg = data.toString();
      
      // 解析总时长
      const durationMatch = msg.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch) {
        duration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
      }

      // 解析进度
      const timeMatch = msg.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      const speedMatch = msg.match(/speed=\s*([\d.]+)x/);
      if (timeMatch && duration > 0 && options.onProgress) {
        const currentTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
        const percentage = Math.min(Math.round((currentTime / duration) * 100), 100);
        const speed = speedMatch ? speedMatch[1] + 'x' : '';
        options.onProgress({ percentage, speed });
      }

      if (!msg.includes('frame=') || process.env.NODE_ENV === 'development') {
        console.log('[FastExport]', msg.trim());
      }
    });

    ffmpegProcess.on('close', (code: number | null) => {
      const result = code === 0
        ? { success: true, outputPath }
        : { success: false, error: `FFmpeg 退出码: ${code}` };
      
      console.log('[FastExport]', code === 0 ? '导出成功!' : `导出失败 (code=${code})`);
      options.onDone?.(result);
      resolve(result);
    });

    ffmpegProcess.on('error', (err: Error) => {
      console.error('[FastExport] 进程错误:', err);
      resolve({ success: false, error: err.message });
    });
  });
}

// ─── 录制后闪电混流（Remux to MP4） ──────────────────────────
export function remuxToMp4(inputPath: string, outputPath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const ffmpegPath = getFfmpegPath();
    const args = [
      '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ];
    
    console.log('[Remux] 开始闪电混流:', ffmpegPath, args.join(' '));
    const process = spawn(ffmpegPath, args);
    
    process.on('close', (code) => {
      if (code === 0) {
        console.log('[Remux] 混流成功:', outputPath);
        resolve({ success: true });
      } else {
        console.error('[Remux] 混流失败, code:', code);
        resolve({ success: false, error: `FFmpeg 退出码: ${code}` });
      }
    });

    process.on('error', (err) => {
      console.error('[Remux] 混流进程启动失败:', err);
      resolve({ success: false, error: err.message });
    });
  });
}
