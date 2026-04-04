// mp4Demuxer.ts
import * as MP4Box from 'mp4box';

export class MP4Demuxer {
  file: any;
  onConfig: (config: VideoDecoderConfig) => void;
  onChunk: (chunk: EncodedVideoChunk) => void;
  onDone: () => void;
  trackId: number = 0;
  getDecodeQueueSize?: () => number;

  constructor(uri: string, { onConfig, onChunk, onDone, getDecodeQueueSize }: { onConfig: (config: VideoDecoderConfig) => void, onChunk: (chunk: EncodedVideoChunk) => void, onDone: () => void, getDecodeQueueSize?: () => number }) {
    this.onConfig = onConfig;
    this.onChunk = onChunk;
    this.onDone = onDone;
    this.getDecodeQueueSize = getDecodeQueueSize;
    // mp4box handles ES modules weirdly sometimes
    const MP4B = (MP4Box as any).createFile ? MP4Box : (MP4Box as any).default || MP4Box;
    this.file = (MP4B as any).createFile();

    this.file.onReady = (info: any) => {
      const track = info.videoTracks[0];
      this.trackId = track.id;
      
      const config: VideoDecoderConfig = {
        codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec, 
        codedHeight: track.video.height,
        codedWidth: track.video.width,
        description: this.description(track)
      };
      
      this.onConfig(config);
      this.file.setExtractionOptions(this.trackId);
      this.file.start();
    };

    let appendedBytes = 0;
    let expectedBytes = -1;

    this.file.onSamples = (id: number, user: any, samples: any[]) => {
      for (const sample of samples) {
        this.onChunk(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: 1000000 * sample.cts / sample.timescale,
          duration: 1000000 * sample.duration / sample.timescale,
          data: sample.data
        }));
      }
    };

    fetch(uri).then(async (res) => {
      expectedBytes = parseInt(res.headers.get('content-length') || '-1');
      const reader = res.body!.getReader();
      let offset = 0;

      const read = async () => {
        const { done, value } = await reader.read();
        if (done) {
          this.file.flush();
          // We can't strictly call onDone here because samples might still be extracted asynchronously.
          // In MP4Box, flush is synchronous for extracting.
          setTimeout(() => this.onDone(), 100);
          return;
        }
        const buf = value.buffer as any;
        buf.fileStart = offset;
        offset += buf.byteLength;
        appendedBytes += buf.byteLength;
        
        // Push buffer to MP4Box. This computes synchronously.
        this.file.appendBuffer(buf);
        
        // Backpressure throttling
        const waitDecoded = () => {
          if (getDecodeQueueSize && getDecodeQueueSize() > 30) {
            setTimeout(waitDecoded, 10);
          } else {
            read(); // Request next chunk of MP4 file chunks
          }
        };
        waitDecoded();
      };
      read();
    }).catch(e => {
      console.error('Demux fetch failed', e);
      this.onDone();
    });
  }

  private description(track: any) {
    const trak = this.file.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        // Find MP4Box globally or from current import
        const MP4B = (MP4Box as any).createFile ? MP4Box : (MP4Box as any).default || MP4Box;
        const stream = new (MP4B as any).DataStream(undefined, 0, (MP4B as any).DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);  // Remove the box header.
      }
    }
    return undefined;
  }
}
