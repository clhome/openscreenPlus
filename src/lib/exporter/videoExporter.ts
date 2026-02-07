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
