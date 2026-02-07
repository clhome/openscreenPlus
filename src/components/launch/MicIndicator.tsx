import { useState, useEffect, useRef, useCallback } from 'react';
import { HiMiniMicrophone } from 'react-icons/hi2';

interface MicIndicatorProps {
    /** 是否正在录制 */
    isRecording: boolean;
    /** 当前音频模式是否包含麦克风 */
    hasMic: boolean;
    /** 选中的麦克风设备 ID */
    micDeviceId?: string | null;
    /** 组件尺寸 */
    size?: 'sm' | 'md';
}

/**
 * 麦克风音量指示器组件
 * 实时显示麦克风输入的音量波形，帮助用户确认麦克风是否正常工作
 * 
 * 注意：使用 setInterval 而不是 requestAnimationFrame 来更新音量，
 * 避免与视频录制/渲染循环产生冲突导致画面闪烁。
 */
export function MicIndicator({
    isRecording,
    hasMic,
    micDeviceId,
    size = 'sm',
}: MicIndicatorProps) {
    const [volume, setVolume] = useState(0);
    const [isActive, setIsActive] = useState(false);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dataArrayRef = useRef<Uint8Array | null>(null);

    // 清理资源
    const cleanup = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        analyserRef.current = null;
        dataArrayRef.current = null;
        setIsActive(false);
        setVolume(0);
    }, []);

    // 更新音量 - 由 setInterval 调用
    const updateVolume = useCallback(() => {
        if (!analyserRef.current || !dataArrayRef.current) return;

        analyserRef.current.getByteFrequencyData(dataArrayRef.current as Uint8Array<ArrayBuffer>);

        // 计算平均音量
        let sum = 0;
        for (let i = 0; i < dataArrayRef.current.length; i++) {
            sum += dataArrayRef.current[i];
        }
        const average = sum / dataArrayRef.current.length;

        // 归一化到 0-1 范围
        const normalizedVolume = Math.min(average / 128, 1);
        setVolume(normalizedVolume);
    }, []);

    // 初始化麦克风音频分析
    const initMicAnalyzer = useCallback(async () => {
        try {
            cleanup();

            // 使用 ideal 而不是 exact 约束，避免与正在录制的流产生冲突
            // 某些系统上，使用 exact 约束同时访问同一设备可能导致问题
            const constraints: MediaStreamConstraints = {
                audio: micDeviceId
                    ? { deviceId: { ideal: micDeviceId } }
                    : true,
                video: false,
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            streamRef.current = stream;

            const audioContext = new AudioContext();
            audioContextRef.current = audioContext;

            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.5;

            source.connect(analyser);
            analyserRef.current = analyser;

            const bufferLength = analyser.frequencyBinCount;
            dataArrayRef.current = new Uint8Array(bufferLength);

            setIsActive(true);

            // 使用 setInterval 而不是 requestAnimationFrame
            // 每 100ms 更新一次音量，避免与视频渲染循环产生冲突
            intervalRef.current = setInterval(updateVolume, 100);

        } catch (error) {
            console.warn('MicIndicator: Failed to initialize microphone analyzer:', error);
            setIsActive(false);
        }
    }, [micDeviceId, cleanup, updateVolume]);

    // 当录制状态或麦克风设置变化时，初始化或清理
    useEffect(() => {
        if (isRecording && hasMic) {
            // 稍微延迟初始化，让录制流先稳定
            const timer = setTimeout(() => {
                initMicAnalyzer();
            }, 200);
            return () => {
                clearTimeout(timer);
                cleanup();
            };
        } else {
            cleanup();
        }

        return cleanup;
    }, [isRecording, hasMic, initMicAnalyzer, cleanup]);

    // 如果不在录制或没有麦克风，不渲染
    if (!isRecording || !hasMic) {
        return null;
    }

    const iconSize = size === 'sm' ? 14 : 18;
    const barCount = 3;
    const maxBarHeight = size === 'sm' ? 12 : 16;
    const minBarHeight = 2;

    return (
        <div
            className="flex items-center gap-1"
            title={isActive ? '麦克风正在录制' : '麦克风连接中...'}
        >
            <HiMiniMicrophone
                size={iconSize}
                className={isActive ? 'text-[#34B27B]' : 'text-white/50'}
            />

            {/* 音量波形条 */}
            <div className="flex items-end gap-[2px]" style={{ height: maxBarHeight }}>
                {Array.from({ length: barCount }).map((_, i) => {
                    // 为每个条添加一些延迟和变化，使动画更自然
                    const delay = i * 0.1;
                    const heightMultiplier = Math.sin((volume + delay) * Math.PI);
                    const barHeight = Math.max(
                        minBarHeight,
                        minBarHeight + (maxBarHeight - minBarHeight) * heightMultiplier * volume
                    );

                    return (
                        <div
                            key={i}
                            className="w-[3px] rounded-full transition-all duration-100"
                            style={{
                                height: barHeight,
                                backgroundColor: volume > 0.1 ? '#34B27B' : 'rgba(255,255,255,0.3)',
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
}
