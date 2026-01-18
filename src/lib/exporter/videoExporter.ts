import type { ExportConfig, ExportProgress, ExportResult } from './types';
import { VideoFileDecoder } from './videoDecoder';
import { FrameRenderer } from './frameRenderer';
import { VideoMuxer } from './muxer';
import { AudioExtractor } from './audioExtractor';
import type { ZoomRegion, CropRegion, TrimRegion, AnnotationRegion } from '@/components/video-editor/types';

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
  private readonly MAX_ENCODE_QUEUE = 30; // 降低队列限制，减少内存占用
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
  private muxingPromises: Promise<void>[] = [];
  private chunkCount = 0;
  private hasAudio = false;
  private videoElement: HTMLVideoElement | null = null;

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
      if (!this.videoElement) throw new Error('Video element not available');

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
        trimRegions: this.config.trimRegions?.map(t => ({ startMs: t.startMs, endMs: t.endMs })),
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
      const sortedTrims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);

      const segments: { start: number, end: number }[] = [];
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

      // 4. MAIN LOOP using Playback + SetTimeout (No rVFC)
      for (const segment of segments) {
        if (this.cancelled) break;

        // Seek and Play
        this.videoElement.currentTime = segment.start;
        await new Promise<void>(resolve => {
          const onSeeked = () => {
            this.videoElement!.removeEventListener('seeked', onSeeked);
            resolve();
          };
          this.videoElement!.addEventListener('seeked', onSeeked, { once: true });
        });

        await this.recordSegment(
          this.videoElement,
          segment.end,
          frameDuration,
          totalFrames,
          startTime,
          () => processedFrames++
        );
      }

      if (this.cancelled) {
        return { success: false, error: 'Export cancelled' };
      }

      if (this.encoder && this.encoder.state === 'configured') {
        await this.encoder.flush();
      }

      if (this.hasAudio && this.audioExtractor && this.muxer) {
        await this.audioExtractor.encode(this.muxer);
      }

      await Promise.all(this.muxingPromises);
      const blob = await this.muxer!.finalize();

      return { success: true, blob };

    } catch (error) {
      console.error('Export error:', error);
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
    onFrameProcessed: () => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let isPausedForEncoding = false;

      // Start Playing
      video.play().catch(reject);

      const tick = async () => {
        if (this.cancelled) {
          video.pause();
          resolve();
          return;
        }

        // 1. Check End Condition
        const currentTime = video.currentTime;
        if (currentTime >= endTime - 0.05 || video.ended) {
          video.pause();
          resolve();
          return;
        }

        // 2. Check Backpressure
        if (this.encodeQueue > this.MAX_ENCODE_QUEUE) {
          if (!isPausedForEncoding) {
            isPausedForEncoding = true;
            video.pause();
          }
          // Wait aggressively until queue clears
          setTimeout(tick, 50);
          return;
        }

        // 3. Resume if needed
        if (isPausedForEncoding && this.encodeQueue < 10) {
          isPausedForEncoding = false;
          video.play().catch(console.error);
        }

        // 4. Capture Frame Logic
        // 我们需要决定：是现在抓一帧，还是等一下？
        // 如果 video.currentTime 已经跑到了下一帧的时间点，就抓。
        // 如果没跑到，就等。

        // 我们需要维护一个"当前已处理到的时间点" -> lastProcessedTime
        // 下一帧的目标时间是 lastProcessedTime + (1/fps)

        // 如果刚开始，lastProcessedTime 是 segment.start (在 loop 外设置)
        // 这里初始 lastProcessedTime 可能是 seek 后的时间

        // 简单策略：如果 currentTime 变了，且足以构成新的一帧（或者我们只是尽可能快地采样？）
        // 不，必须按帧率采样。

        // 用 chunkCount 来计算理想时间戳
        // targetTimestamp = chunkCount * (1/fps)
        // 但这是 relative to start of EXPORT, not segment.
        // wait, recordSegment calls are sequential.

        // 其实只需要检测 video.currentTime 是否前进了足够多
        // 但是 video.play() 是连续的。

        // 关键点：我们导出的是 60fps 固定帧率。
        // 我们希望 video 也是以 1.0x 速度播放。
        // 所以理论上，真实时间过 16ms，video.currentTime 过 16ms，我们就抓一帧。

        // 只要 currentTime 超过了 "上一帧时间 + 0.5 * frameInterval"，我们就认为可以抓下一帧了
        // 为了防止重复抓同一帧，我们需要记录 lastCapturedVideoTime

        // 更好的方式：
        // 每一帧的 timestamp 是确定的： frames[i].timestamp = i * frameDuration
        // 我们只需要从 video 中拿到 *那个时刻* 的图像。
        // 由于我们在播放，video 图像在不断变。
        // 我们检查 video.currentTime。如果它 >= targetVideoTime，我们就抓。
        // targetVideoTime = segmentStart + (framesInSegment * frameInterval)

        // 这里需要在 recordSegment 内部维护局部帧计数

        // 简化逻辑：
        // 只要能抓，就抓。
        // 然后给这一帧打上正确的时间戳。
        // 这样会不会导致忽快忽慢？
        // 如果抓得太快（video还没走），会抓到重帧 -> 看起来像卡顿。
        // 如果抓得太慢（video走远了），会跳帧。

        // 理想：setTimeout(..., 16)
        // 每次醒来，抓一帧。
        // 这样基本是同步的。

        try {
          const timestamp = this.chunkCount * frameDuration;

          // Render
          // @ts-ignore
          const videoFrame = new VideoFrame(video, { timestamp: 0 }); // Grab current texture
          await this.renderer!.renderFrame(videoFrame, currentTime * 1000000);
          videoFrame.close();

          const canvas = this.renderer!.getCanvas();

          // Encode
          // @ts-ignore
          const exportFrame = new VideoFrame(canvas, {
            timestamp: timestamp,
            duration: frameDuration,
            colorSpace: {
              primaries: 'bt709',
              transfer: 'iec61966-2-1',
              matrix: 'rgb',
              fullRange: true,
            },
          });

          if (this.encoder && this.encoder.state === 'configured') {
            this.encodeQueue++;
            const isKeyFrame = this.chunkCount % (this.config.frameRate * 2) === 0;
            this.encoder.encode(exportFrame, { keyFrame: isKeyFrame });
          }
          exportFrame.close();

          this.chunkCount++; // 全局计数增加
          onFrameProcessed();

          // Progress
          if (this.config.onProgress && this.chunkCount % 5 === 0) {
            // ... progress logic ...
            const elapsed = (performance.now() - globalStartTime) / 1000;
            const fps = this.chunkCount / (elapsed || 1);
            const remaining = (totalFrames - this.chunkCount) / fps;
            this.config.onProgress({
              currentFrame: this.chunkCount,
              totalFrames: totalFrames,
              percentage: Math.min(99, (this.chunkCount / totalFrames) * 100),
              estimatedTimeRemaining: remaining
            });
          }

        } catch (e) {
          console.error("Frame processing error:", e);
        }

        // Schedule next tick
        // 这里的 timeout 决定了抓取的频率。
        // 如果设为 frameInterval (16ms)，理论上跟得上。
        // 如果系统慢，会变慢，video 也会继续播吗？
        // 不，video.play() 也是依赖主线程的。如果 JS 忙，视频播放也会卡。
        // 所以大致是同步的。

        setTimeout(tick, Math.floor(1000 / this.config.frameRate));
      };

      // Kickoff
      setTimeout(tick, 0);
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
          videoDescription = new Uint8Array(desc instanceof ArrayBuffer ? desc : (desc as any));
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
            if (isFirstChunk && this.videoDescription) { // 这里逻辑稍有风险，改用 videoDescription 判空
              // 其实只要 videoDescription 刚拿到，就应该是头
              const colorSpace = this.videoColorSpace || {
                primaries: 'bt709',
                transfer: 'iec61966-2-1',
                matrix: 'rgb',
                fullRange: true,
              };

              const metadata: EncodedVideoChunkMetadata = {
                decoderConfig: {
                  codec: this.config.codec || 'avc1.640033',
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
            console.error('Muxing error:', error);
          }
        })();

        this.muxingPromises.push(muxingPromise);
        this.encodeQueue--;
      },
      error: (error) => {
        console.error('Encoder error:', error);
        this.cancelled = true;
      },
    });

    const codec = this.config.codec || 'avc1.640033';
    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.frameRate,
      latencyMode: 'realtime', // Play模式用 realtime 更好
      bitrateMode: 'variable',
      hardwareAcceleration: 'prefer-hardware',
    };

    const hardwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);
    if (hardwareSupport.supported) {
      this.encoder.configure(encoderConfig);
    } else {
      encoderConfig.hardwareAcceleration = 'prefer-software';
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
        if (this.encoder.state === 'configured') this.encoder.close();
      } catch (e) { }
      this.encoder = null;
    }
    if (this.decoder) {
      try { this.decoder.destroy(); } catch (e) { }
      this.decoder = null;
    }
    if (this.renderer) {
      try { this.renderer.destroy(); } catch (e) { }
      this.renderer = null;
    }
    if (this.audioExtractor) {
      try { this.audioExtractor.destroy(); } catch (e) { }
      this.audioExtractor = null;
    }

    this.muxer = null;
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    this.videoDescription = undefined;
    this.videoColorSpace = undefined;
    this.hasAudio = false;
    this.videoElement = null;
  }
}
