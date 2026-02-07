import { useState, useRef, useEffect } from "react";
import { fixWebmDuration } from "@fix-webm-duration/fix";
import { type AudioMode } from "./useAudioDevices";
import { showError, showWarning } from "@/lib/errorHandler";

type UseScreenRecorderReturn = {
  recording: boolean;
  paused: boolean;
  toggleRecording: () => void;
  togglePause: () => void;
};

export function useScreenRecorder(
  audioMode: AudioMode,
  selectedMicDeviceId: string | null
): UseScreenRecorderReturn {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startTime = useRef<number>(0);
  const pausedTime = useRef<number>(0);  // 累计暂停时间
  const pauseStartTime = useRef<number>(0);  // 暂停开始时间

  // 使用 ref 来存储最新的音频设置，避免闭包问题
  const audioModeRef = useRef(audioMode);
  const selectedMicDeviceIdRef = useRef(selectedMicDeviceId);

  // 同步状态到 ref
  useEffect(() => {
    audioModeRef.current = audioMode;
  }, [audioMode]);

  useEffect(() => {
    selectedMicDeviceIdRef.current = selectedMicDeviceId;
  }, [selectedMicDeviceId]);

  // Target visually lossless 4K @ 60fps; fall back gracefully when hardware cannot keep up
  const TARGET_FRAME_RATE = 60;
  const TARGET_WIDTH = 3840;
  const TARGET_HEIGHT = 2160;
  const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;

  const selectMimeType = () => {
    // 优先使用 H.264 编码，这样转换为 MP4 时更快
    const preferred = [
      "video/webm;codecs=h264",  // H.264 优先，转 MP4 最快
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm;codecs=av1",
      "video/webm"
    ];

    return preferred.find(type => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
  };

  const computeBitrate = (width: number, height: number) => {
    const pixels = width * height;
    const highFrameRateBoost = TARGET_FRAME_RATE >= 60 ? 1.7 : 1;

    if (pixels >= FOUR_K_PIXELS) {
      return Math.round(45_000_000 * highFrameRateBoost);
    }

    if (pixels >= 2560 * 1440) {
      return Math.round(28_000_000 * highFrameRateBoost);
    }

    return Math.round(18_000_000 * highFrameRateBoost);
  };

  const stopRecording = useRef(() => {
    if (mediaRecorder.current?.state === "recording" || mediaRecorder.current?.state === "paused") {
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
      }
      mediaRecorder.current.stop();
      setRecording(false);
      setPaused(false);
      pausedTime.current = 0;

      window.electronAPI?.setRecordingState(false);

      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    }
  });

  // 暂停/继续录制
  const togglePause = useRef(() => {
    if (!mediaRecorder.current) return;

    if (mediaRecorder.current.state === "recording") {
      mediaRecorder.current.pause();
      pauseStartTime.current = Date.now();
      setPaused(true);
    } else if (mediaRecorder.current.state === "paused") {
      mediaRecorder.current.resume();
      // 累加暂停时间
      pausedTime.current += Date.now() - pauseStartTime.current;
      setPaused(false);
    }
  });

  useEffect(() => {
    let cleanupStop: (() => void) | undefined;
    let cleanupPause: (() => void) | undefined;

    if (window.electronAPI?.onStopRecordingFromTray) {
      cleanupStop = window.electronAPI.onStopRecordingFromTray(() => {
        stopRecording.current();
      });
    }

    if (window.electronAPI?.onPauseRecordingFromTray) {
      cleanupPause = window.electronAPI.onPauseRecordingFromTray(() => {
        togglePause.current();
      });
    }

    return () => {
      if (cleanupStop) cleanupStop();
      if (cleanupPause) cleanupPause();

      if (mediaRecorder.current?.state === "recording" || mediaRecorder.current?.state === "paused") {
        mediaRecorder.current.stop();
      }
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
        stream.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      const selectedSource = await window.electronAPI.getSelectedSource();
      if (!selectedSource) {
        showWarning('请先选择录制源', '请在开始录制前选择要录制的屏幕或窗口');
        return;
      }

      const currentAudioMode = audioModeRef.current;
      const currentMicDeviceId = selectedMicDeviceIdRef.current;


      // 获取屏幕视频流（包含系统音频）
      const needsSystemAudio = currentAudioMode === 'system' || currentAudioMode === 'both';

      // 收集所有轨道
      const tracks: MediaStreamTrack[] = [];

      // 尝试同时获取视频和系统音频（这在某些系统上更可靠）
      if (needsSystemAudio) {
        try {
          const combinedStream = await (navigator.mediaDevices as any).getUserMedia({
            audio: {
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: selectedSource.id,
              },
            },
            video: {
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: selectedSource.id,
                maxWidth: TARGET_WIDTH,
                maxHeight: TARGET_HEIGHT,
                maxFrameRate: TARGET_FRAME_RATE,
                minFrameRate: 30,
              },
            },
          });

          tracks.push(...combinedStream.getVideoTracks());
          tracks.push(...combinedStream.getAudioTracks());
        } catch (combinedError) {
          // 无法同时获取视频和系统音频，尝试分开获取

          // 分开获取视频
          const videoStream = await (navigator.mediaDevices as any).getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: selectedSource.id,
                maxWidth: TARGET_WIDTH,
                maxHeight: TARGET_HEIGHT,
                maxFrameRate: TARGET_FRAME_RATE,
                minFrameRate: 30,
              },
            },
          });
          tracks.push(...videoStream.getVideoTracks());

          // 尝试单独获取系统音频
          try {
            const systemAudioStream = await (navigator.mediaDevices as any).getUserMedia({
              audio: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: selectedSource.id,
                },
              },
              video: false,
            });

            const systemAudioTracks = systemAudioStream.getAudioTracks();
            if (systemAudioTracks.length > 0) {
              tracks.push(...systemAudioTracks);
            }
          } catch (systemAudioError) {
            showWarning('无法录制系统音频', '录制将继续，但不包含系统声音');
          }
        }
      } else {
        // 只获取视频，不需要系统音频
        const videoStream = await (navigator.mediaDevices as any).getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: selectedSource.id,
              maxWidth: TARGET_WIDTH,
              maxHeight: TARGET_HEIGHT,
              maxFrameRate: TARGET_FRAME_RATE,
              minFrameRate: 30,
            },
          },
        });
        tracks.push(...videoStream.getVideoTracks());
      }


      // 获取麦克风音频
      const needsMicAudio = currentAudioMode === 'mic' || currentAudioMode === 'both';

      if (needsMicAudio) {
        try {
          // 构建麦克风约束
          const micConstraints: MediaTrackConstraints = {
            echoCancellation: true,
            noiseSuppression: true,
          };

          // 如果指定了设备 ID，则使用该设备
          if (currentMicDeviceId) {
            micConstraints.deviceId = { exact: currentMicDeviceId };
          } else {
          }

          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: micConstraints,
            video: false,
          });
          const micTracks = micStream.getAudioTracks();
          if (micTracks.length > 0) {
          }
          tracks.push(...micTracks);
        } catch (micError) {
          // 如果指定的设备失败，尝试使用默认设备
          if (currentMicDeviceId) {
            try {
              const fallbackMicStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  echoCancellation: true,
                  noiseSuppression: true,
                },
                video: false,
              });
              const fallbackMicTracks = fallbackMicStream.getAudioTracks();
              tracks.push(...fallbackMicTracks);
            } catch (fallbackError) {
              showWarning('无法录制麦克风音频', '录制将继续，但不包含麦克风声音');
            }
          }
        }
      }


      // 分离视频和音频轨道
      const audioTracks = tracks.filter(t => t.kind === 'audio');
      const videoTracks = tracks.filter(t => t.kind === 'video');

      let finalStream: MediaStream;

      // 无论是否有音频轨道，都通过 AudioContext 处理
      // 这确保音频被正确缓冲和同步，避免与视频帧率不匹配导致画面闪烁
      // 即使是静音模式，也生成一个静音轨道来保持同步
      const audioContext = new AudioContext();
      audioCtxRef.current = audioContext;
      const destination = audioContext.createMediaStreamDestination();

      if (audioTracks.length > 0) {
        if (audioTracks.length > 1) {
          // 多个音频轨道：使用压缩器和增益节点混合
          const compressor = audioContext.createDynamicsCompressor();
          compressor.threshold.value = -24;
          compressor.knee.value = 30;
          compressor.ratio.value = 12;
          compressor.attack.value = 0.003;
          compressor.release.value = 0.25;
          compressor.connect(destination);

          const gainPerTrack = Math.min(0.6, 1.0 / audioTracks.length);

          audioTracks.forEach((track) => {
            const source = audioContext.createMediaStreamSource(new MediaStream([track]));
            const gainNode = audioContext.createGain();
            gainNode.gain.value = gainPerTrack;
            source.connect(gainNode);
            gainNode.connect(compressor);
          });
        } else {
          // 单个音频轨道（例如只有麦克风）：也通过 AudioContext 处理
          // 这样可以确保音频流与视频流的时钟同步
          const source = audioContext.createMediaStreamSource(new MediaStream([audioTracks[0]]));
          const gainNode = audioContext.createGain();
          gainNode.gain.value = 1.0;  // 保持原始音量
          source.connect(gainNode);
          gainNode.connect(destination);
        }
      } else {
        // 无音频（静音模式）：创建一个静音信号
        // 添加一个增益为0的振荡器，确保 AudioContext 处于活跃状态并提供时钟信号
        const oscillator = audioContext.createOscillator();
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        oscillator.connect(silentGain);
        silentGain.connect(destination);
        oscillator.start();
      }

      // 创建最终的流：视频轨道 + 处理后的音频轨道
      finalStream = new MediaStream([
        ...videoTracks,
        ...destination.stream.getAudioTracks()
      ]);

      stream.current = finalStream;
      if (!stream.current) {
        throw new Error("Media stream is not available.");
      }
      const videoTrack = stream.current.getVideoTracks()[0];
      try {
        await videoTrack.applyConstraints({
          frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
          width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
          height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
        });
      } catch (error) {
      }

      let { width = 1920, height = 1080 } = videoTrack.getSettings();

      // Ensure dimensions are divisible by 2 for VP9/AV1 codec compatibility
      width = Math.floor(width / 2) * 2;
      height = Math.floor(height / 2) * 2;

      const videoBitsPerSecond = computeBitrate(width, height);
      const mimeType = selectMimeType();



      chunks.current = [];
      const recorder = new MediaRecorder(stream.current, {
        mimeType,
        videoBitsPerSecond,
      });
      mediaRecorder.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunks.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.current = null;
        if (chunks.current.length === 0) return;
        // 计算实际录制时长（减去暂停时间）
        const totalTime = Date.now() - startTime.current;
        const duration = totalTime - pausedTime.current;
        const recordedChunks = chunks.current;
        const buggyBlob = new Blob(recordedChunks, { type: mimeType });
        // Clear chunks early to free memory immediately after blob creation
        chunks.current = [];
        pausedTime.current = 0;
        const timestamp = Date.now();
        const videoFileName = `recording-${timestamp}.webm`;

        try {
          const videoBlob = await fixWebmDuration(buggyBlob, duration);
          const arrayBuffer = await videoBlob.arrayBuffer();
          const videoResult = await window.electronAPI.storeRecordedVideo(arrayBuffer, videoFileName);
          if (!videoResult.success) {
            console.error('Failed to store video:', videoResult.message);
            return;
          }

          if (videoResult.path) {
            await window.electronAPI.setCurrentVideoPath(videoResult.path);
          }

          await window.electronAPI.switchToEditor();
        } catch (error) {
          console.error('Error saving recording:', error);
        }
      };
      recorder.onerror = () => setRecording(false);
      recorder.start(1000);
      startTime.current = Date.now();
      setRecording(true);
      window.electronAPI?.setRecordingState(true);
    } catch (error) {
      showError(error, 'recording');
      setRecording(false);
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
        stream.current = null;
      }
    }
  };

  const toggleRecording = () => {
    recording ? stopRecording.current() : startRecording();
  };

  return { recording, paused, toggleRecording, togglePause: togglePause.current };
}
