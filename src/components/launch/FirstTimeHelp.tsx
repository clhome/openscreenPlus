import { useState, useEffect } from "react";
import { X, Keyboard, Monitor, Mic, Play } from "lucide-react";
import { Button } from "../ui/button";

const FIRST_TIME_KEY = "openscreenplus-first-time-shown";

interface FirstTimeHelpProps {
  /** 强制显示帮助，忽略 localStorage 状态 */
  forceShow?: boolean;
}

/**
 * 初次使用帮助组件
 * 首次打开应用时显示使用指南和快捷键说明
 */
export function FirstTimeHelp({ forceShow = false }: FirstTimeHelpProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // 检查是否首次启动
    if (forceShow) {
      setIsVisible(true);
      return;
    }

    const hasShown = localStorage.getItem(FIRST_TIME_KEY);
    if (!hasShown) {
      setIsVisible(true);
    }
  }, [forceShow]);

  useEffect(() => {
    if (isVisible) {
      // 当帮助显示时，确保能够点击
      window.electronAPI?.setIgnoreMouseEvents(false);
    }
    // 不再在 else 分支设置 setIgnoreMouseEvents(true)，因为这会导致 Windows 上无法点击
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;

    // 30秒无反应自动进入首页
    const timer = setTimeout(() => {
      handleClose();
    }, 30000);

    return () => clearTimeout(timer);
  }, [isVisible]);

  const handleClose = () => {
    // 总是标记为已显示，因为没有"不再显示"选项了，默认就是看过一次就行
    // 或者如果用户希望每次重置缓存后都能看到，可以根据需求调整
    // 这里假设只要关闭了就算看过了
    localStorage.setItem(FIRST_TIME_KEY, "true");
    setIsVisible(false);
    // 不要设置穿透，保持窗口可点击
  };

  if (!isVisible) return null;

  return (
    <>
      {/* 背景遮罩 - 点击关闭 */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] animate-in fade-in duration-200 pointer-events-auto"
        onClick={handleClose}
        title="点击任意位置关闭"
      />

      {/* 帮助面板 - 使用固定宽度，适配小窗口 */}
      <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[101] bg-[#0f0f12] rounded-2xl shadow-2xl border border-white/10 p-6 w-[480px] max-w-[calc(100vw-40px)] max-h-[calc(100vh-40px)] overflow-y-auto animate-in zoom-in-95 duration-200">
        {/* 标题栏 - 更明显的关闭按钮 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-white">
              欢迎使用 OpenScreenPlus 🎬
            </h2>
            <p className="text-sm text-slate-400 mt-1">快速开始录制您的屏幕</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-full transition-all"
            title="关闭 (ESC)"
          >
            <X className="w-6 h-6" />
          </Button>
        </div>

        {/* 使用步骤 - 紧凑布局 */}
        <div className="space-y-3 mb-5">
          <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
            <div className="w-8 h-8 rounded-full bg-[#34B27B]/20 flex items-center justify-center flex-shrink-0">
              <Monitor className="w-4 h-4 text-[#34B27B]" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-white text-sm">1. 选择录制源</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                点击屏幕图标选择要录制的屏幕或窗口
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
            <div className="w-8 h-8 rounded-full bg-[#34B27B]/20 flex items-center justify-center flex-shrink-0">
              <Mic className="w-4 h-4 text-[#34B27B]" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-white text-sm">2. 设置音频</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                选择是否录制系统声音和麦克风
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
            <div className="w-8 h-8 rounded-full bg-[#34B27B]/20 flex items-center justify-center flex-shrink-0">
              <Play className="w-4 h-4 text-[#34B27B]" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-white text-sm">3. 开始录制</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                点击录制按钮开始，录制完成后自动进入编辑器
              </p>
            </div>
          </div>
        </div>

        {/* 快捷键说明 - 紧凑布局 */}
        <div className="p-3 rounded-xl bg-white/5 border border-white/5 mb-5">
          <div className="flex items-center gap-2 mb-2">
            <Keyboard className="w-4 h-4 text-[#34B27B]" />
            <span className="font-medium text-white text-sm">快捷键</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>停止录制</span>
              <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white font-mono text-[10px]">
                Ctrl+Shift+S
              </kbd>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>暂停/继续</span>
              <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white font-mono text-[10px]">
                Ctrl+Shift+P
              </kbd>
            </div>
          </div>
        </div>

        {/* 底部提示 (无按钮) */}
        <div className="flex justify-center pt-3 border-t border-white/10">
          <p className="text-center text-xs text-slate-500">
            按{" "}
            <kbd className="px-1 py-0.5 rounded bg-white/10 text-white font-mono text-[10px]">
              ESC
            </kbd>{" "}
            或点击任意位置关闭
          </p>
        </div>
      </div>
    </>
  );
}
