/// <reference types="vite/client" />
/// <reference types="../electron/electron-env" />

interface ProcessedDesktopSource {
  id: string;
  name: string;
  display_id: string;
  thumbnail: string | null;
  appIcon: string | null;
}

interface Window {
  electronAPI: {
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => void
    }
    getSources: (opts: Electron.SourcesOptions) => Promise<ProcessedDesktopSource[]>
    switchToEditor: () => Promise<void>
    openSourceSelector: () => Promise<void>
    selectSource: (source: any) => Promise<any>
    getSelectedSource: () => Promise<any>
    storeRecordedVideo: (videoData: ArrayBuffer, fileName: string) => Promise<{
      success: boolean
      path?: string
      message: string
      error?: string
    }>
    getRecordedVideoPath: () => Promise<{
      success: boolean
      path?: string
      message?: string
      error?: string
    }>
    getAssetBasePath: () => Promise<string | null>
    setRecordingState: (recording: boolean) => Promise<void>
    onStopRecordingFromTray: (callback: () => void) => () => void
    onPauseRecordingFromTray: (callback: () => void) => () => void
    onGlobalShortcut: (callback: (action: string) => void) => () => void
    getShortcutSettings: () => Promise<{ stopRecording: string; pauseRecording: string }>
    setShortcutSettings: (settings: { stopRecording: string; pauseRecording: string }) => Promise<{ success: boolean }>
    setIgnoreMouseEvents: (ignore: boolean, options?: { forward: boolean }) => void
    openExternalUrl: (url: string) => Promise<{ success: boolean; error?: string }>
    saveExportedVideo: (videoData: ArrayBuffer, fileName: string) => Promise<{
      success: boolean
      path?: string
      message?: string
      cancelled?: boolean
    }>
    openVideoFilePicker: () => Promise<{ success: boolean; path?: string; cancelled?: boolean }>
    setCurrentVideoPath: (path: string) => Promise<{ success: boolean }>
    getCurrentVideoPath: () => Promise<{ success: boolean; path?: string }>
    clearCurrentVideoPath: () => Promise<{ success: boolean }>
    getPlatform: () => Promise<string>
    getMouseData: (videoPath: string) => Promise<{
      success: boolean
      data?: {
        version: number
        frameRate: number
        positions: Array<{ time: number; x: number; y: number }>
      } | null
      message?: string
      error?: string
    }>
    hudOverlayHide: () => void
    hudOverlayClose: () => void
    resizeOverlay: (width: number, height: number) => Promise<{ success: boolean }>
    // 倒计时窗口
    showCountdown: () => Promise<{ success: boolean }>
    closeCountdown: () => Promise<{ success: boolean }>
    onCountdownComplete: (callback: () => void) => () => void
    onCountdownCancelled: (callback: () => void) => () => void
    sendCountdownComplete: () => void
    sendCountdownCancelled: () => void
  }
}

// WebCodecs Audio API Types
interface AudioEncoderInit {
  output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void;
  error: (error: DOMException) => void;
}

interface AudioEncoderConfig {
  codec: string;
  sampleRate?: number;
  numberOfChannels?: number;
  bitrate?: number;
  [key: string]: any;
}

interface EncodedAudioChunk {
  type: 'key' | 'delta';
  timestamp: number;
  duration: number | null;
  byteLength: number;
  copyTo(destination: BufferSource, options?: any): void;
}

interface EncodedAudioChunkMetadata {
  decoderConfig?: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    description?: BufferSource;
  };
}

interface AudioData {
  close(): void;
  clone(): AudioData;
  readonly format: 'u8' | 's16' | 's32' | 'f32' | 'u8-planar' | 's16-planar' | 's32-planar' | 'f32-planar' | null;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  readonly timestamp: number;
  alloc(options: { numberOfChannels: number; numberOfFrames: number; sampleRate: number; format: string; timestamp: number; data: BufferSource; transfer?: Transferable[] }): void;
  copyTo(destination: BufferSource, options: { planeIndex: number; frameOffset?: number; frameCount?: number; format?: string }): void;
}

declare class AudioEncoder {
  constructor(init: AudioEncoderInit);
  readonly state: "configured" | "unconfigured" | "closed";
  readonly encodeQueueSize: number;
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  close(): void;
  static isConfigSupported(config: AudioEncoderConfig): Promise<{ supported: boolean; config: AudioEncoderConfig }>;
}