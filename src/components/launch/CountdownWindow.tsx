import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

const COUNTDOWN_SECONDS = 3;

export function CountdownWindow() {
  const { t } = useTranslation();
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);

  const handleComplete = useCallback(() => {
    if (window.electronAPI?.sendCountdownComplete) {
      window.electronAPI.sendCountdownComplete();
    }
  }, []);

  const handleCancel = useCallback(() => {
    if (window.electronAPI?.sendCountdownCancelled) {
      window.electronAPI.sendCountdownCancelled();
    }
  }, []);

  useEffect(() => {
    if (countdown <= 0) {
      handleComplete();
      return;
    }

    const timer = setTimeout(() => {
      setCountdown(countdown - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [countdown, handleComplete]);

  // 按 ESC 键取消
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCancel]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        zIndex: 9999,
        cursor: "pointer",
      }}
      onClick={handleCancel}
    >
      {/* 倒计时数字 */}
      <div
        style={{
          fontSize: "200px",
          fontWeight: 700,
          color: "#fff",
          textShadow: "0 0 60px rgba(59, 130, 246, 0.8), 0 0 120px rgba(59, 130, 246, 0.4)",
          animation: "countdown-pulse 1s ease-in-out infinite",
          userSelect: "none",
          fontFamily: "Inter, system-ui, sans-serif",
          lineHeight: 1,
          zIndex: 2,
        }}
      >
        {countdown}
      </div>

      {/* 提示文字 */}
      <div
        style={{
          marginTop: "32px",
          fontSize: "20px",
          color: "rgba(255, 255, 255, 0.7)",
          userSelect: "none",
          zIndex: 2,
        }}
      >
        {t("recording.countdownHint", "按 ESC 取消")}
      </div>

      {/* 进度环 */}
      <svg
        style={{
          position: "absolute",
          width: "320px",
          height: "320px",
        }}
      >
        {/* 背景环 */}
        <circle
          cx="160"
          cy="160"
          r="140"
          fill="none"
          stroke="rgba(255, 255, 255, 0.1)"
          strokeWidth="8"
        />
        {/* 进度环 */}
        <circle
          cx="160"
          cy="160"
          r="140"
          fill="none"
          stroke="url(#countdownGradient)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${2 * Math.PI * 140}`}
          strokeDashoffset={`${2 * Math.PI * 140 * (1 - countdown / COUNTDOWN_SECONDS)}`}
          style={{
            transform: "rotate(-90deg)",
            transformOrigin: "center",
            transition: "stroke-dashoffset 1s linear",
          }}
        />
        <defs>
          <linearGradient id="countdownGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#3B82F6" />
            <stop offset="50%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="#EC4899" />
          </linearGradient>
        </defs>
      </svg>

      {/* CSS 动画 */}
      <style>{`
        @keyframes countdown-pulse {
          0%, 100% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(1.05);
            opacity: 0.9;
          }
        }
      `}</style>
    </div>
  );
}
