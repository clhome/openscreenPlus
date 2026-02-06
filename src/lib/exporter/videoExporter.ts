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
  private readonly MAX_ENCODE_QUEUE = 60; // 增大队列限制，提升导出速度
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
  private muxingPromises: Promise<void>[] = [];
  private chunkCount = 0;
  private hasAudio = false;
  private videoElement: HTMLVideoElement | null = null;
  private audioChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];

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
      this.hasAudio = await this.audioExtractor.decode();

      this.muxer = new VideoMuxer(this.config, this.hasAudio);
      await this.muxer.initialize();

      // 2. 准备导出参数
      const effectiveDuration = this.getEffectiveDuration(videoInfo.duration);
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);
      const frameDuration = 1_000_000 / this.config.frameRate;

      this.videoElement.playbackRate = 1.0;
      this.videoElement.muted = true;
      // 禁用 loop, 防止播完自动重播导致逻辑混乱
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
      }

      // 4. MAIN LOOP using Playback + SetTimeout (No rVFC)
      for (const segment of segments) {
        if (this.cancelled) break;

        // Seek and Play
        this.videoElement.currentTime = segment.start;
        await new Promise<void>((resolve) => {
          const onSeeked = () => {
            this.videoElement!.removeEventListener("seeked", onSeeked);
            resolve();
          };
          this.videoElement!.addEventListener("seeked", onSeeked, {
            once: true,
          });
        });

        await this.recordSegment(
          this.videoElement,
          segment.end,
          frameDuration,
          totalFrames,
          startTime,
          () => processedFrames++,
          segment.start,
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
        for (const { chunk, meta } of this.audioChunks) {
           await this.muxer.addAudioChunk(chunk, meta);
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

  private async recordSegment(
    video: HTMLVideoElement,
    endTime: number,
    frameDuration: number,
    totalFrames: number,
    globalStartTime: number,
    onFrameProcessed: () => void,
    segmentStartTime: number,
  ): Promise<void> {
    // 使用 seek-based 快速导出方式，不再使用实时播放
    const frameInterval = 1 / this.config.frameRate; // 每帧时间间隔（秒）
    let currentVideoTime = segmentStartTime;

    while (currentVideoTime < endTime && !this.cancelled) {
      // 1. 等待编码队列有空间
      while (this.encodeQueue > this.MAX_ENCODE_QUEUE && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (this.cancelled) break;

      // 2. Seek 到目标时间
      video.currentTime = currentVideoTime;
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked, { once: true });
        // 如果已经在目标位置，直接 resolve
        if (Math.abs(video.currentTime - currentVideoTime) < 0.01) {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        }
      });

      // 3. 采样当前帧
      try {
        const timestamp = this.chunkCount * frameDuration;

        // Render
        const videoFrame = new VideoFrame(video, { timestamp: 0 });
        await this.renderer!.renderFrame(videoFrame, currentVideoTime * 1000000);
        videoFrame.close();

        const canvas = this.renderer!.getCanvas();

        // Encode
        // @ts-expect-error VideoFrame constructor
        const exportFrame = new VideoFrame(canvas, {
          timestamp: timestamp,
          duration: frameDuration,
          colorSpace: {
            primaries: "bt709",
            transfer: "iec61966-2-1",
            matrix: "rgb",
            fullRange: true,
          },
        });

        if (this.encoder && this.encoder.state === "configured") {
          this.encodeQueue++;
          const isKeyFrame = this.chunkCount % (this.config.frameRate * 2) === 0;
          this.encoder.encode(exportFrame, { keyFrame: isKeyFrame });
        }
        exportFrame.close();

        this.chunkCount++;
        onFrameProcessed();

        // Progress - 每 5 帧更新一次
        if (this.config.onProgress && this.chunkCount % 5 === 0) {
          const elapsed = (performance.now() - globalStartTime) / 1000;
          const fps = this.chunkCount / (elapsed || 1);
          const remaining = (totalFrames - this.chunkCount) / fps;
          this.config.onProgress({
            currentFrame: this.chunkCount,
            totalFrames: totalFrames,
            percentage: Math.min(99, (this.chunkCount / totalFrames) * 100),
            estimatedTimeRemaining: remaining,
          });
        }
      } catch (e) {
        console.error("Frame processing error:", e);
      }

      // 4. 交织写入音频
      // 检查并在当前输出时间之前的音频块写入 Muxer
      // 使用输出时间戳(output timestamp)而不是输入视频时间(source timestamp)，因为剪辑会导致两者不一致
      if (this.muxer && this.audioChunks.length > 0) {
        const currentOutputTimestampUs = this.chunkCount * frameDuration;
        // 允许音频稍微超前视频一点 (比如 0.5秒)，以确保音频不中断
        const lookAheadUs = 500_000; 
        
        while (this.audioChunks.length > 0 && this.audioChunks[0].chunk.timestamp <= currentOutputTimestampUs + lookAheadUs) {
           const item = this.audioChunks.shift();
           if (item) {
             const { chunk, meta } = item;
             await this.muxer.addAudioChunk(chunk, meta);
           }
        }
      }

      // 5. 移动到下一帧
      currentVideoTime += frameInterval;
    }
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
        // 注意：chunkCount 在 recordSegment 里已经递增了，这里是 encode output callback
        // 用闭包里的局部变量标记第一帧可能不准，最好检查 chunk.timestamp
        // 但这里我们只关心 header

        const muxingPromise = (async () => {
          try {
            if (isFirstChunk && this.videoDescription) {
              // 这里逻辑稍有风险，改用 videoDescription 判空
              // 其实只要 videoDescription 刚拿到，就应该是头
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
      latencyMode: "realtime", // Play模式用 realtime 更好
      bitrateMode: "variable",
      hardwareAcceleration: "prefer-hardware",
    };

    const hardwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);
    if (hardwareSupport.supported) {
      this.encoder.configure(encoderConfig);
    } else {
      encoderConfig.hardwareAcceleration = "prefer-software";
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
