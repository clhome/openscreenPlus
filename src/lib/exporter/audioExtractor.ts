/**
 * 专业级离线音频提取器
 * 1. 使用 OfflineAudioContext 进行精确解码和剪辑拼接
 * 2. 严格控制 PCM 格式 (Float32 Planar) 以匹配 AudioEncoder
 * 3. 避免任何实时流依赖，确保导出稳定性
 */

export interface AudioSegment {
    startMs: number;
    endMs: number;
}

export interface AudioExtractorConfig {
    videoUrl: string;
    trimRegions?: AudioSegment[];
}

export class AudioExtractor {
    private config: AudioExtractorConfig;
    private audioContext: AudioContext | null = null;
    private rawAudioBuffer: AudioBuffer | null = null;
    private processedBuffer: AudioBuffer | null = null;

    constructor(config: AudioExtractorConfig) {
        this.config = config;
    }

    /**
     * 解码并处理音频
     */
    async decode(): Promise<boolean> {
        try {
            const response = await fetch(this.config.videoUrl);
            const arrayBuffer = await response.arrayBuffer();

            // 使用 AudioContext 解码（浏览器环境）
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            if (!this.audioContext) {
                throw new Error('AudioContext not supported');
            }

            this.rawAudioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

            // 处理剪辑 (Trim)
            this.processedBuffer = this.processTrimRegions(this.rawAudioBuffer);

            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * 根据 trimRegions 拼接音频
     */
    private processTrimRegions(source: AudioBuffer): AudioBuffer {
        const trimRegions = this.config.trimRegions;

        // 如果没有剪辑，直接返回原 Buffer
        if (!trimRegions || trimRegions.length === 0) {
            return source;
        }

        const sampleRate = source.sampleRate;
        const channels = source.numberOfChannels;

        // 1. 计算总长度
        let totalFrames = 0;
        for (const region of trimRegions) {
            const startFrame = Math.floor((region.startMs / 1000) * sampleRate);
            const endFrame = Math.floor((region.endMs / 1000) * sampleRate);
            totalFrames += Math.max(0, endFrame - startFrame);
        }

        if (totalFrames === 0) return source;

        // 2. 创建新的 AudioBuffer
        const dest = this.audioContext!.createBuffer(channels, totalFrames, sampleRate);

        // 3. 复制数据
        let destOffset = 0;
        for (const region of trimRegions) {
            const startFrame = Math.floor((region.startMs / 1000) * sampleRate);
            const endFrame = Math.floor((region.endMs / 1000) * sampleRate);
            const length = Math.max(0, endFrame - startFrame);

            if (length > 0) {
                for (let channel = 0; channel < channels; channel++) {
                    const sourceData = source.getChannelData(channel);
                    const destData = dest.getChannelData(channel);

                    // 性能优化的批量复制
                    // 注意：subarray 不复制数据，set 才是复制
                    const segment = sourceData.subarray(startFrame, startFrame + length);
                    destData.set(segment, destOffset);
                }
                destOffset += length;
            }
        }

        return dest;
    }

    /**
     * 将处理后的 AudioBuffer 编码并写入 Muxer
     * 使用严格的切片逻辑
     */
    async encode(muxer: any): Promise<void> {
        if (!this.processedBuffer) return;

        const buffer = this.processedBuffer;
        const sampleRate = buffer.sampleRate;
        const numberOfChannels = buffer.numberOfChannels;



        return new Promise((resolve, reject) => {
            // 1. 配置编码器
            const encoder = new AudioEncoder({
                output: (chunk, meta) => {
                    muxer.addAudioChunk(chunk, meta).catch((e: any) => console.error('Muxer add audio error:', e));
                },
                error: (e) => {
                    console.error('AudioEncoder error:', e);
                    reject(e);
                }
            });

            encoder.configure({
                codec: 'mp4a.40.2', // AAC LC
                sampleRate: sampleRate,
                numberOfChannels: numberOfChannels,
                bitrate: 128000,
            });

            // 2. 切片处理
            // 每一帧音频通常 10ms - 20ms，这里用 1024 个采样点作为一个基础单位 (frame)
            // WebCodecs 建议 chunk 包含完整的 PCM 帧，AAC 通常以 1024 采样点为一帧
            const SAMPLES_PER_CHUNK = 1024 * 4; // 较大块以提高性能
            let offset = 0;
            const totalSamples = buffer.length;

            // 准备 Planar Data
            // AudioData 'f32-planar' 需要数据布局：[CH1 DATA][CH2 DATA]...

            const processChunks = async () => {
                try {
                    while (offset < totalSamples) {
                        const length = Math.min(SAMPLES_PER_CHUNK, totalSamples - offset);
                        const timestampUs = (offset / sampleRate) * 1_000_000;

                        // 构建 planar buffer
                        const planarBuffer = new Float32Array(length * numberOfChannels);
                        for (let ch = 0; ch < numberOfChannels; ch++) {
                            const channelData = buffer.getChannelData(ch);
                            // 复制该通道的切片到 massive buffer 正确位置
                            // Planar 布局：Channel 1 占前 length，Channel 2 占后 length
                            planarBuffer.set(channelData.subarray(offset, offset + length), ch * length);
                        }

                        const audioData = new AudioData({
                            format: 'f32-planar',
                            sampleRate: sampleRate,
                            numberOfFrames: length,
                            numberOfChannels: numberOfChannels,
                            timestamp: timestampUs,
                            data: planarBuffer
                        });

                        encoder.encode(audioData);
                        audioData.close();

                        offset += length;

                        // 让出主线程防止卡死
                        if (offset % (sampleRate * 5) < length) { // 每5秒休息一下
                            await new Promise(r => setTimeout(r, 0));
                        }
                    }

                    await encoder.flush();
                    encoder.close();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            };

            processChunks();
        });
    }

    /**
     * 预先编码音频并返回所有块，用于与视频交织写入
     */
    async getAllEncodedChunks(): Promise<{ chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[]> {
        if (!this.processedBuffer) return [];

        const buffer = this.processedBuffer;
        const sampleRate = buffer.sampleRate;
        const numberOfChannels = buffer.numberOfChannels;
        const chunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];

        return new Promise((resolve, reject) => {
            const encoder = new AudioEncoder({
                output: (chunk, meta) => {
                    chunks.push({ chunk, meta });
                },
                error: (e) => {
                    console.error('AudioEncoder error:', e);
                    reject(e);
                }
            });

            encoder.configure({
                codec: 'mp4a.40.2',
                sampleRate: sampleRate,
                numberOfChannels: numberOfChannels,
                bitrate: 128000,
            });

            const SAMPLES_PER_CHUNK = 1024 * 4;
            let offset = 0;
            const totalSamples = buffer.length;

            const processChunks = async () => {
                try {
                    while (offset < totalSamples) {
                        const length = Math.min(SAMPLES_PER_CHUNK, totalSamples - offset);
                        const timestampUs = (offset / sampleRate) * 1_000_000;

                        const planarBuffer = new Float32Array(length * numberOfChannels);
                        for (let ch = 0; ch < numberOfChannels; ch++) {
                            const channelData = buffer.getChannelData(ch);
                            planarBuffer.set(channelData.subarray(offset, offset + length), ch * length);
                        }

                        const audioData = new AudioData({
                            format: 'f32-planar',
                            sampleRate: sampleRate,
                            numberOfFrames: length,
                            numberOfChannels: numberOfChannels,
                            timestamp: timestampUs,
                            data: planarBuffer
                        });

                        encoder.encode(audioData);
                        audioData.close();

                        offset += length;

                        if (offset % (sampleRate * 5) < length) {
                            await new Promise(r => setTimeout(r, 0));
                        }
                    }

                    await encoder.flush();
                    encoder.close();
                    resolve(chunks);
                } catch (e) {
                    reject(e);
                }
            };

            processChunks();
        });
    }

    destroy() {
        this.rawAudioBuffer = null;
        this.processedBuffer = null;
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
    }
}
