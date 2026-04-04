import type { ExportConfig, ExportProgress, ExportResult } from "./types";
import { VideoFileDecoder } from "./videoDecoder";
import { FrameRenderer } from "./frameRenderer";
import { VideoMuxer } from "./muxer";
import { AudioExtractor } from "./audioExtractor";
import type {
  ZoomRegion,
  CropRegion,
  TrimRegion,
  AnnotationRegion,
} from "@/components/video-editor/types";

interface VideoExporterConfig extends ExportConfig {
  videoUrl: string;
  wallpaper: string;
  zoomRegions: ZoomRegion[];
  trimRegions?: TrimRegion[];
  showShadow: boolean;
  shadowIntensity: number;
  showBlur: boolean;
  motionBlurEnabled?: boolean;
  borderRadius?: number;
  padding?: number;
  videoPadding?: number;
  cropRegion: CropRegion;
  annotationRegions?: AnnotationRegion[];
  previewWidth?: number;
  previewHeight?: number;
  onProgress?: (progress: ExportProgress) => void;
}

export class VideoExporter {
  private config: VideoExporterConfig;
  private decoder: VideoFileDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private encoder: VideoEncoder | null = null;
  private muxer: VideoMuxer | null = null;
  private audioExtractor: AudioExtractor | null = null;
  private cancelled = false;
  private encodeQueue = 0;
  private readonly MAX_ENCODE_QUEUE = 60;
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
  private muxingPromises: Promise<void>[] = [];
  private chunkCount = 0;
  private hasAudio = false;
  private videoElement: HTMLVideoElement | null = null;
  private audioChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
  
  // 导出加速倍数：2.0 表示 2 倍速导出
  // 音频时间戳会相应调整以保持同步
  private readonly PLAYBACK_SPEED = 2.0;

  constructor(config: VideoExporterConfig) {
    this.config = config;
  }

  private getEffectiveDuration(totalDuration: number): number {
    const trimRegions = this.config.trimRegions || [];
    const totalTrimDuration = trimRegions.reduce((sum, region) => {
      const start = Math.max(0, region.startMs);
      const end = Math.min(totalDuration * 1000, region.endMs);
      if (end > start) {
        return sum + (end - start) / 1000;
      }
      return sum;
    }, 0);
    return Math.max(0, totalDuration - totalTrimDuration);
  }

  async export(): Promise<ExportResult> {
    try {
      this.cleanup();
      this.cancelled = false;

      // 0. 检查是否可以使用 FFmpeg 高速导出
      if (window.electronAPI?.ffmpegExport) {
        return await this.exportWithFfmpeg();
      }

      // 1. 初始化
      this.decoder = new VideoFileDecoder();
      const videoInfo = await this.decoder.loadVideo(this.config.videoUrl);
      this.videoElement = this.decoder.getVideoElement();
      if (!this.videoElement) throw new Error("Video element not available");

      this.renderer = new FrameRenderer({
        width: this.config.width,
        height: this.config.height,
        wallpaper: this.config.wallpaper,
        zoomRegions: this.config.zoomRegions,
        showShadow: this.config.showShadow,
        shadowIntensity: this.config.shadowIntensity,
        showBlur: this.config.showBlur,
        motionBlurEnabled: this.config.motionBlurEnabled,
        borderRadius: this.config.borderRadius,
        padding: this.config.padding,
        cropRegion: this.config.cropRegion,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        annotationRegions: this.config.annotationRegions,
        previewWidth: this.config.previewWidth,
        previewHeight: this.config.previewHeight,
      });
      await this.renderer.initialize();

      await this.initializeEncoder();

      this.audioExtractor = new AudioExtractor({
        videoUrl: this.config.videoUrl,
        trimRegions: this.config.trimRegions?.map((t) => ({
          startMs: t.startMs,
          endMs: t.endMs,
        })),
      });
      console.log('[VideoExporter] Starting audio decode...');
      this.hasAudio = await this.audioExtractor.decode();
      console.log('[VideoExporter] Audio decode result:', this.hasAudio);

      this.muxer = new VideoMuxer(this.config, this.hasAudio);
      await this.muxer.initialize();

      // 2. 准备导出参数
      const effectiveDuration = this.getEffectiveDuration(videoInfo.duration);
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);
      const frameDuration = 1_000_000 / this.config.frameRate;

      this.videoElement.muted = true;
      this.videoElement.loop = false;

      const startTime = performance.now();
      let processedFrames = 0;

      // 3. 计算片段 (Trim Support)
      const trimRegions = this.config.trimRegions || [];
      const sortedTrims = [...trimRegions].sort(
        (a, b) => a.startMs - b.startMs,
      );

      const segments: { start: number; end: number }[] = [];
      let currentPos = 0;
      for (const trim of sortedTrims) {
        if (trim.startMs > currentPos) {
          segments.push({ start: currentPos / 1000, end: trim.startMs / 1000 });
        }
        currentPos = trim.endMs;
      }
      if (currentPos < videoInfo.duration * 1000) {
        segments.push({ start: currentPos / 1000, end: videoInfo.duration });
      }
      if (segments.length === 0 && (!trimRegions || trimRegions.length === 0)) {
        segments.push({ start: 0, end: videoInfo.duration });
      }

      // 3.5 预先编码音频 (如果存在)
      if (this.hasAudio && this.audioExtractor) {
        this.audioChunks = await this.audioExtractor.getAllEncodedChunks();
        console.log('[VideoExporter] Audio chunks extracted:', this.audioChunks.length);
      }

      // 4. 使用播放模式导出
      for (const segment of segments) {
        if (this.cancelled) break;

        await this.recordSegmentWithPlayback(
          this.videoElement,
          segment.start,
          segment.end,
          frameDuration,
          totalFrames,
          startTime,
          () => processedFrames++,
        );
      }

      if (this.cancelled) {
        return { success: false, error: "Export cancelled" };
      }

      if (this.encoder && this.encoder.state === "configured") {
        await this.encoder.flush();
      }

      // 写入剩余的所有音频 (如果有)
      if (this.audioChunks.length > 0 && this.muxer) {
        console.log('[VideoExporter] Writing remaining audio chunks:', this.audioChunks.length);
        for (const { chunk, meta } of this.audioChunks) {
           // 剩余音频也需要调整时间戳
           await this.muxer.addAudioChunkWithAdjustedTimestamp(chunk, meta, this.PLAYBACK_SPEED);
        }
        this.audioChunks = [];
      }

      await Promise.all(this.muxingPromises);
      const blob = await this.muxer!.finalize();

      // 导出完成后发送 100% 进度
      if (this.config.onProgress) {
        this.config.onProgress({
          currentFrame: totalFrames,
          totalFrames: totalFrames,
          percentage: 100,
          estimatedTimeRemaining: 0,
        });
      }

      return { success: true, blob };
    } catch (error) {
      console.error("Export error:", error);
      return { success: false, error: String(error) };
    } finally {
      this.cleanup();
    }
  }

  /**
   * 使用视频正常播放的方式导出，而不是快速 seek
   * 这样可以保证每帧都是完整解码的，避免 WGC 错误
   */
  private async recordSegmentWithPlayback(
    video: HTMLVideoElement,
    startTime: number,
    endTime: number,
    frameDuration: number,
    totalFrames: number,
    globalStartTime: number,
    onFrameProcessed: () => void,
  ): Promise<void> {
    const targetFrameInterval = 1 / this.config.frameRate;
    
    // 使用加速播放提高导出速度
    video.playbackRate = this.PLAYBACK_SPEED;
    
    // Seek 到起始位置
    video.currentTime = startTime;
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked, { once: true });
    });
    
    // 开始播放
    await video.play().catch((e) => console.error("Play failed:", e));
    
    let nextFrameTime = startTime;
    let isPausedForCapture = false;
    
    return new Promise<void>((resolve, reject) => {
      let animationFrameId: number | null = null;
      
      const captureLoop = async () => {
        if (this.cancelled) {
          cleanup();
          resolve();
          return;
        }
        
        const currentTime = video.currentTime;
        
        // 流控逻辑：如果视频播放太快（超过下一帧时间 0.1秒），暂停等待捕获
        // 这样可以防止 2倍速播放导致跳帧或提前结束
        if (!video.paused && currentTime > nextFrameTime + 0.1) {
          video.pause();
          isPausedForCapture = true;
        }
        
        // 如果已经追上进度（小于 0.05秒差距），且是因为捕获暂停的，则恢复播放
        if (isPausedForCapture && currentTime <= nextFrameTime + 0.05 && !video.ended) {
          await video.play().catch(() => {});
          isPausedForCapture = false;
        }
        
        // 检查是否需要捕获当前帧
        // 我们允许 currentTime 稍微超过 nextFrameTime，只要不超过太远
        if (currentTime >= nextFrameTime) {
          // 等待编码队列有空间
          while (this.encodeQueue > this.MAX_ENCODE_QUEUE && !this.cancelled) {
            await new Promise((r) => setTimeout(r, 5));
          }
          
          if (this.cancelled) {
            cleanup();
            resolve();
            return;
          }
          
          try {
            const timestamp = this.chunkCount * frameDuration;
            
            // 调试日志（只打印前几帧）
            if (this.chunkCount < 5) {
               console.log(`[VideoExporter] Capture frame ${this.chunkCount}: time=${timestamp}μs, videoTime=${currentTime}s`);
            }
            
            // 直接从播放中的视频创建 VideoFrame
            const videoFrame = new VideoFrame(video, { timestamp: 0 });
            await this.renderer!.renderFrame(videoFrame, currentTime * 1000000);
            videoFrame.close();
            
            const canvas = this.renderer!.getCanvas();
            
            const exportFrame = new VideoFrame(canvas, {
              timestamp: timestamp,
              duration: frameDuration,
            });
            
            this.encodeQueue++;
            this.encoder!.encode(exportFrame, { keyFrame: this.chunkCount % 150 === 0 });
            exportFrame.close();
            this.chunkCount++;
            
            onFrameProcessed();
            
            // 交织写入音频
            // 恢复为原始逻辑：直接写入音频块，不需要调整时间戳
            // 因为我们现在保证了视频帧是完整的，音视频是对齐的
            if (this.muxer && this.audioChunks.length > 0) {
              const currentOutputTimestampUs = this.chunkCount * frameDuration;
              const lookAheadUs = 500_000; // 0.5秒预读
              
              while (
                this.audioChunks.length > 0 &&
                this.audioChunks[0].chunk.timestamp <= currentOutputTimestampUs + lookAheadUs
              ) {
                const item = this.audioChunks.shift();
                if (item) {
                  const { chunk, meta } = item;
                  await this.muxer.addAudioChunk(chunk, meta);
                }
              }
            }
            
            // Progress
            if (this.config.onProgress && this.chunkCount % 5 === 0) {
              const elapsed = (performance.now() - globalStartTime) / 1000;
              const fps = this.chunkCount / (elapsed || 1);
              const remaining = (totalFrames - this.chunkCount) / fps;
              this.config.onProgress({
                currentFrame: this.chunkCount,
                totalFrames: totalFrames,
                percentage: Math.min(Math.round((this.chunkCount / totalFrames) * 100), 100),
                estimatedTimeRemaining: Math.ceil(remaining),
              });
            }
            
            // 推进到下一帧
            nextFrameTime += targetFrameInterval;
            
            // 如果连续捕获，确保稍微让出主线程
            if (video.currentTime >= nextFrameTime) {
                // 如果还落后很多，可能需要在同一帧循环里多捕获几次吗？
                // 不，requestAnimationFrame 循环通常足够快。
                // 如果我们在这里由循环捕获，画面会重复。
                // 我们让循环继续。
            }
            
          } catch (e) {
            console.error("Frame capture error:", e);
          }
        }
        
        // 结束条件：必须在所有帧都处理完，或者视频真的结束了且我们也到了末尾
        // 注意：endTime 是片段结束时间
        if ((video.ended || currentTime >= endTime) && currentTime < nextFrameTime) {
             // 视频播完了，且我们没有下一帧要捕获了（nextFrameTime > currentTime 说明我们已经捕获到了尽头）
             cleanup();
             resolve();
             return;
        }
        
        // 如果视频结束了，但 nextFrameTime 还没到？说明我们丢帧了。
        // 但有了流控，这种情况应该很罕见。如果真的发生，强制退出避免死循环。
        if (video.ended && this.chunkCount < totalFrames * 0.99) {
             console.warn("Video ended early, some frames might be missing.");
             cleanup();
             resolve();
             return;
        }
        
        animationFrameId = requestAnimationFrame(captureLoop);
      };
      
      const onError = (e: Event) => {
        console.error("Video playback error", e);
        cleanup();
        reject(new Error("Video playback error"));
      };
      
      const cleanup = () => {
        if (animationFrameId !== null) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        video.removeEventListener("error", onError);
        video.pause();
      };
      
      video.addEventListener("error", onError, { once: true });
      
      animationFrameId = requestAnimationFrame(captureLoop);
    });
  }

  private async initializeEncoder(): Promise<void> {
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    let videoDescription: Uint8Array | undefined;

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !videoDescription) {
          const desc = meta.decoderConfig.description;
          videoDescription = new Uint8Array(
            desc instanceof ArrayBuffer ? desc : (desc as any),
          );
          this.videoDescription = videoDescription;
        }
        if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
          this.videoColorSpace = meta.decoderConfig.colorSpace;
        }

        const isFirstChunk = this.chunkCount === 0;

        const muxingPromise = (async () => {
          try {
            if (isFirstChunk && this.videoDescription) {
              const colorSpace = this.videoColorSpace || {
                primaries: "bt709",
                transfer: "iec61966-2-1",
                matrix: "rgb",
                fullRange: true,
              };

              const metadata: EncodedVideoChunkMetadata = {
                decoderConfig: {
                  codec: this.config.codec || "avc1.640033",
                  codedWidth: this.config.width,
                  codedHeight: this.config.height,
                  description: this.videoDescription,
                  colorSpace,
                },
              };

              await this.muxer!.addVideoChunk(chunk, metadata);
            } else {
              await this.muxer!.addVideoChunk(chunk, meta);
            }
          } catch (error) {
            console.error("Muxing error:", error);
          }
        })();

        this.muxingPromises.push(muxingPromise);
        this.encodeQueue--;
      },
      error: (error) => {
        console.error("Encoder error:", error);
        this.cancelled = true;
      },
    });

    const codec = this.config.codec || "avc1.640033";
    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.frameRate,
      latencyMode: "quality",
      bitrateMode: "variable",
      hardwareAcceleration: "prefer-software",
    };

    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (support.supported) {
      this.encoder.configure(encoderConfig);
    } else {
      encoderConfig.hardwareAcceleration = "no-preference";
      this.encoder.configure(encoderConfig);
    }
  }

  /**
   * FFmpeg 高速导出逻辑
   * 快速路径：无 Zoom/Annotation 时使用纯 FFmpeg 管线（10-20x）
   * 慢速路径：有复杂特效时使用 PixiJS 渲染 + FFmpeg 编码（~1x）
   */
  private async exportWithFfmpeg(): Promise<ExportResult> {
    const hasZoom = this.config.zoomRegions && this.config.zoomRegions.length > 0;
    const hasAnnotations = this.config.annotationRegions && this.config.annotationRegions.length > 0;
    const canUseFastPath = !hasZoom && !hasAnnotations;

    if (canUseFastPath) {
      return await this.exportFastPath();
    }
    try {
      // 慢速路径：1. 初始化资源
      this.decoder = new VideoFileDecoder();
      const videoInfo = await this.decoder.loadVideo(this.config.videoUrl);
      this.videoElement = this.decoder.getVideoElement();
      if (!this.videoElement) throw new Error("Video element not available");

      this.renderer = new FrameRenderer({
        width: this.config.width,
        height: this.config.height,
        wallpaper: this.config.wallpaper,
        zoomRegions: this.config.zoomRegions,
        showShadow: this.config.showShadow,
        shadowIntensity: this.config.shadowIntensity,
        showBlur: this.config.showBlur,
        motionBlurEnabled: this.config.motionBlurEnabled,
        borderRadius: this.config.borderRadius,
        padding: this.config.padding,
        cropRegion: this.config.cropRegion,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        annotationRegions: this.config.annotationRegions,
        previewWidth: this.config.previewWidth,
        previewHeight: this.config.previewHeight,
      });
      await this.renderer.initialize();

      // 不需要 initializeEncoder，因为编码在主进程

      // 2. 导出准备
      const effectiveDuration = this.getEffectiveDuration(videoInfo.duration);
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);

      this.videoElement.muted = true;
      this.videoElement.pause();

      let processedFrames = 0;

      // 让主窗口通过 IPC 通知系统获取导出路径
      // 在这里我们需要一个输出路径。为了方便，我们让主进程在 temp 目录生成，
      // 导出完成后再由 saveExportedVideo 移动。
      const tempPath = `export_${Date.now()}.mp4`;

      // 启动启动 FFmpeg 会话
      const startResult = await window.electronAPI.ffmpegExport.start({
        outputPath: tempPath,
        width: this.config.width,
        height: this.config.height,
        fps: this.config.frameRate,
        audioPath: this.config.videoUrl, // 传入原始视频路径以提取音轨同步封装
        crf: 18,
        useHwAccel: true, // 默认开启硬件加速优化速度
      });

      if (!startResult.ok) {
        throw new Error(`FFmpeg start failed: ${startResult.error}`);
      }

      // 监听完成
      const exportDonePromise = new Promise<{ success: boolean; outputPath?: string; error?: string }>(
        (resolve) => {
          const unsubscribe = window.electronAPI.ffmpegExport.onDone((result) => {
            unsubscribe();
            resolve(result);
          });
        }
      );

      // 3. 逐帧渲染主循环 — 使用顺序播放代替逐帧 Seek
      // Seek 方案在 WebM 上极慢（需要回退到关键帧再解码），顺序播放可利用硬件解码流水线
      const trimRegions = this.config.trimRegions || [];
      const segments: { start: number; end: number }[] = [];
      let currentPos = 0;
      for (const trim of [...trimRegions].sort((a,b)=>a.startMs-b.startMs)) {
        if (trim.startMs > currentPos) segments.push({ start: currentPos/1000, end: trim.startMs/1000 });
        currentPos = trim.endMs;
      }
      if (currentPos < videoInfo.duration * 1000) segments.push({ start: currentPos/1000, end: videoInfo.duration });
      if (segments.length === 0) segments.push({ start: 0, end: videoInfo.duration });

      let cumulativeTime = 0;
      const configFrameRate = this.config.frameRate;

      for (const segment of segments) {
        if (this.cancelled) break;

        // 每段只在开头做一次 seek（段间跳转）
        this.videoElement.currentTime = segment.start;
        await new Promise<void>((r) => {
          const onSeeked = () => { this.videoElement?.removeEventListener('seeked', onSeeked); r(); };
          this.videoElement?.addEventListener('seeked', onSeeked, { once: true });
          setTimeout(() => { this.videoElement?.removeEventListener('seeked', onSeeked); r(); }, 2000);
        });

        // 使用顺序播放捕获帧：比逐帧 Seek 快 3-5 倍
        const segEnd = segment.end;
        const video = this.videoElement;
        const renderer = this.renderer;
        const cancelled = () => this.cancelled;
        const onProgress = this.config.onProgress;
        const ffmpegExport = window.electronAPI.ffmpegExport;

        await new Promise<void>((resolveSegment) => {
          let pending = false; // 防止帧处理重入

          const processNextFrame = async () => {
            if (pending) return;
            pending = true;

            try {
              if (cancelled() || !video) {
                video?.pause();
                resolveSegment();
                return;
              }

              const currentTime = video.currentTime;
              if (currentTime >= segEnd - 0.01) {
                video.pause();
                resolveSegment();
                return;
              }

              // 暂停视频以稳定当前帧
              video.pause();

              // 捕获 + 渲染
              let videoFrame: VideoFrame | null = null;
              try {
                videoFrame = new VideoFrame(video, { timestamp: 0 });
                await renderer.renderFrame(videoFrame, currentTime * 1000000);
              } catch (e) {
                console.error("[FFmpegExporter] Frame capture failed:", e);
              } finally {
                videoFrame?.close();
              }

              //读取像素（compositeCanvas 是 2D canvas）
              const canvas = renderer.getCanvas();
              const ctx = canvas.getContext('2d')!;
              const frameBuffer = ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer as ArrayBuffer;

              // 严格音画同步 (Strict CFR sync):
              // 根据目前累积的时间，计算应该发送多少帧到 FFmpeg
              const globalVideoTime = cumulativeTime + (currentTime - segment.start);
              const targetFrames = Math.floor(globalVideoTime * configFrameRate) + 1;
              const framesToPush = targetFrames - processedFrames;

              if (framesToPush > 0) {
                // 如果落后目标帧数，补帧（通常是1帧，如果是跳帧或低帧率可能会补偿多帧）
                for (let i = 0; i < framesToPush; i++) {
                  let bufferToSend: ArrayBuffer;
                  if (i === framesToPush - 1) {
                    bufferToSend = frameBuffer; // 最后一帧直接使用
                  } else {
                    bufferToSend = frameBuffer.slice(0); // 复制 buffer 防止被移交所有权
                  }
                  
                  const pushPromise = ffmpegExport.pushFrame(bufferToSend);
                  processedFrames++;

                  if (onProgress && processedFrames % 5 === 0) {
                    onProgress({
                      currentFrame: processedFrames,
                      totalFrames,
                      percentage: Math.min(Math.round((processedFrames / totalFrames) * 100), 100),
                      estimatedTimeRemaining: 0,
                    });
                  }

                  // 背压控制：每 10 帧等一次
                  if (processedFrames % 10 === 0) {
                    await pushPromise;
                  }
                } // 结束 for
              } // 结束 if

              // 恢复播放，等待下一帧
              pending = false;
              video.play();

              if ('requestVideoFrameCallback' in video) {
                (video as HTMLVideoElement).requestVideoFrameCallback(() => processNextFrame());
              } else {
                requestAnimationFrame(() => processNextFrame());
              }

            } catch (err) {
              console.error("[FFmpegExporter] Loop error:", err);
              pending = false;
              video?.pause();
              resolveSegment();
            }
          };

          // 启动帧回调循环
          video.playbackRate = 1.0;
          
          // 监听视频播放到末尾，防止 requestVideoFrameCallback 不再回调导致卡死
          video.addEventListener('ended', () => {
            video.pause();
            resolveSegment();
          }, { once: true });

          if ('requestVideoFrameCallback' in video) {
            (video as HTMLVideoElement).requestVideoFrameCallback(() => processNextFrame());
          } else {
            requestAnimationFrame(() => processNextFrame());
          }
          video.play();
        });

        cumulativeTime += (segment.end - segment.start);
      }

      if (this.cancelled) {
        await window.electronAPI.ffmpegExport.cancel();
        return { success: false, error: "Export cancelled" };
      }

      // 4. 完成
      await window.electronAPI.ffmpegExport.finish();
      const doneResult = await exportDonePromise;

      if (!doneResult.success) {
        throw new Error(doneResult.error || "FFmpeg export failed");
      }
      
      // 返回路径。虽然 ExportResult 类型可能需要更新，
      // 但我先把它放在 blob 位置或者直接返回。
      // 注意：这里需要确保 UI 层能处理 blob 为空的情况。
      return { 
        success: true, 
        blob: new Blob([]),
        filePath: doneResult.outputPath
      } as ExportResult;

    } catch (error) {
      console.error("FFmpeg export error:", error);
      return { success: false, error: String(error) };
    } finally {
      this.cleanup();
    }
  }

  /**
   * 快速路径：纯 FFmpeg 管线，10-20x 速度
   */
  private async exportFastPath(): Promise<ExportResult> {
    console.log('[VideoExporter] 使用纯 FFmpeg 快速导出路径');

    const tempPath = `export_${Date.now()}.mp4`;

    // 解析背景色
    let bgColor = '#1a1a2e';
    const wallpaper = this.config.wallpaper || '';
    if (wallpaper.startsWith('#')) {
      bgColor = wallpaper;
    } else if (wallpaper.includes('#')) {
      const match = wallpaper.match(/#[0-9a-fA-F]{3,8}/);
      if (match) bgColor = match[0];
    }

    // 监听进度
    let unsubProgress: (() => void) | null = null;
    if (this.config.onProgress) {
      unsubProgress = window.electronAPI.ffmpegExport.onProgress((progress: { percentage: number }) => {
        this.config.onProgress?.({
          currentFrame: 0,
          totalFrames: 100,
          percentage: progress.percentage,
          estimatedTimeRemaining: 0,
        });
      });
    }

    try {
      const result = await window.electronAPI.ffmpegExport.fastExport({
        inputPath: this.config.videoUrl,
        outputPath: tempPath,
        width: this.config.width,
        height: this.config.height,
        fps: this.config.frameRate,
        padding: this.config.padding ?? 32,
        background: bgColor,
        crf: 18,
      });

      unsubProgress?.();

      if (!result.success) {
        throw new Error(result.error || '快速导出失败');
      }

      return {
        success: true,
        blob: new Blob([]),
        filePath: result.outputPath,
      } as ExportResult;
    } catch (error) {
      console.error('FFmpeg fast export error:', error);
      return { success: false, error: String(error) };
    } finally {
      unsubProgress?.();
      this.cleanup();
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.encoder) {
      try {
        if (this.encoder.state === "configured") this.encoder.close();
      } catch (e) {}
      this.encoder = null;
    }
    if (this.decoder) {
      try {
        this.decoder.destroy();
      } catch (e) {}
      this.decoder = null;
    }
    if (this.renderer) {
      try {
        this.renderer.destroy();
      } catch (e) {}
      this.renderer = null;
    }
    if (this.audioExtractor) {
      try {
        this.audioExtractor.destroy();
      } catch (e) {}
      this.audioExtractor = null;
    }

    this.muxer = null;
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    this.videoDescription = undefined;
    this.videoColorSpace = undefined;
    this.hasAudio = false;
    this.audioChunks = [];
    this.videoElement = null;
  }
}
