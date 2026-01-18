/**
 * 鼠标位置追踪工具
 * 用于加载和查询录制时保存的鼠标位置数据
 */

export interface MousePosition {
  time: number;  // 毫秒
  x: number;     // 屏幕坐标
  y: number;     // 屏幕坐标
}

/**
 * 鼠标点击事件
 */
export interface MouseClickEvent {
  time: number;  // 毫秒（相对于录制开始）
  x: number;     // 相对于录制区域的 x 坐标
  y: number;     // 相对于录制区域的 y 坐标
  button: 'left' | 'right' | 'middle';
}

/**
 * 点击缩放模式
 * - smart: 智能模式，跟随鼠标轨迹，AI 判断持续时间
 * - fixed: 固定模式，固定位置，移出区域时结束
 */
export type ClickZoomMode = 'smart' | 'fixed';

export interface MouseData {
  version: number;
  frameRate: number;
  sourceWidth?: number;  // 录制时的屏幕/窗口宽度（v2 新增）
  sourceHeight?: number; // 录制时的屏幕/窗口高度（v2 新增）
  positions: MousePosition[];
  clicks?: MouseClickEvent[];  // 点击事件（v2 新增）
}

export interface NormalizedMousePosition {
  cx: number;  // 归一化坐标 0-1
  cy: number;  // 归一化坐标 0-1
}

/**
 * 加载视频对应的鼠标数据
 */
export async function loadMouseData(videoPath: string): Promise<MouseData | null> {
  try {
    const result = await window.electronAPI.getMouseData(videoPath);
    if (result.success && result.data) {
      return result.data;
    }
    return null;
  } catch (error) {
    console.error('Failed to load mouse data:', error);
    return null;
  }
}

/**
 * 根据时间获取鼠标位置（线性插值）
 */
export function getMousePositionAtTime(
  mouseData: MouseData,
  timeMs: number,
  videoWidth: number,
  videoHeight: number
): NormalizedMousePosition | null {
  const { positions } = mouseData;

  if (positions.length === 0) {
    return null;
  }

  // 找到时间点前后的两个位置
  let beforeIndex = -1;
  let afterIndex = -1;

  for (let i = 0; i < positions.length; i++) {
    if (positions[i].time <= timeMs) {
      beforeIndex = i;
    }
    if (positions[i].time >= timeMs && afterIndex === -1) {
      afterIndex = i;
      break;
    }
  }

  // 如果没有找到，使用边界值
  if (beforeIndex === -1) {
    beforeIndex = 0;
  }
  if (afterIndex === -1) {
    afterIndex = positions.length - 1;
  }

  const before = positions[beforeIndex];
  const after = positions[afterIndex];

  let x: number, y: number;

  if (beforeIndex === afterIndex || before.time === after.time) {
    // 精确匹配或只有一个点
    x = before.x;
    y = before.y;
  } else {
    // 线性插值
    const t = (timeMs - before.time) / (after.time - before.time);
    x = before.x + (after.x - before.x) * t;
    y = before.y + (after.y - before.y) * t;
  }

  // 归一化到 0-1 范围
  // 优先使用源尺寸进行归一化（解决视频缩放导致的偏移问题）
  const widthBase = (mouseData.sourceWidth && mouseData.sourceWidth > 0) ? mouseData.sourceWidth : videoWidth;
  const heightBase = (mouseData.sourceHeight && mouseData.sourceHeight > 0) ? mouseData.sourceHeight : videoHeight;

  return {
    cx: Math.max(0, Math.min(1, x / widthBase)),
    cy: Math.max(0, Math.min(1, y / heightBase)),
  };
}

/**
 * 存储鼠标数据到本地（用于 AI 分析结果）
 */
export function storeMouseDataLocally(key: string, data: MouseData): void {
  try {
    localStorage.setItem(`mouse_data_${key}`, JSON.stringify(data));
  } catch (error) {
    console.error('Failed to store mouse data locally:', error);
  }
}

/**
 * 从本地获取鼠标数据
 */
export function getMouseDataLocally(key: string): MouseData | null {
  try {
    const data = localStorage.getItem(`mouse_data_${key}`);
    if (data) {
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    console.error('Failed to get mouse data locally:', error);
    return null;
  }
}

/**
 * 获取指定时间范围内的鼠标轨迹
 */
export function getMouseTrajectoryInRange(
  mouseData: MouseData,
  startMs: number,
  endMs: number
): MousePosition[] {
  return mouseData.positions.filter(
    pos => pos.time >= startMs && pos.time <= endMs
  );
}

/**
 * 判断当前鼠标位置是否超出点击位置的指定阈值（用于固定模式的边界检测）
 * @param clickPos 点击位置（归一化坐标）
 * @param currentPos 当前鼠标位置（归一化坐标）
 * @param threshold 阈值（归一化距离）
 * @returns 是否超出阈值
 */
export function isMouseOutOfBounds(
  clickPos: { cx: number; cy: number },
  currentPos: { cx: number; cy: number },
  threshold: number
): boolean {
  const distance = Math.hypot(
    currentPos.cx - clickPos.cx,
    currentPos.cy - clickPos.cy
  );
  return distance > threshold;
}

/**
 * 缩放区域建议（从点击事件生成）
 */
export interface ClickZoomSuggestion {
  clickTime: number;          // 第一次点击时间（毫秒）
  clickX: number;             // 点击位置 x（归一化 0-1）
  clickY: number;             // 点击位置 y（归一化 0-1）
  suggestedStartMs: number;   // 建议开始时间
  suggestedEndMs: number;     // 建议结束时间
  button: 'left' | 'right' | 'middle';
  clickCount: number;         // 合并的点击次数
}

/**
 * 从点击事件生成缩放区域建议
 * 
 * 智能合并逻辑：
 * - 支持左键和右键点击
 * - 如果多次点击间隔小于 mergeThresholdMs，合并为一个缩放区域
 * - 合并后的缩放区域从第一次点击开始，到最后一次点击后延续 defaultDurationMs
 * - 焦点位置使用第一次点击的位置（固定模式）
 */
export function generateZoomSuggestionsFromClicks(
  mouseData: MouseData,
  videoWidth: number,
  videoHeight: number,
  defaultDurationMs: number = 2000,
  mergeThresholdMs: number = 1500  // 1.5秒内的点击合并为一组
): ClickZoomSuggestion[] {
  const { clicks } = mouseData;
  if (!clicks || clicks.length === 0) {
    return [];
  }

  // 过滤只保留左键和右键点击
  const validClicks = clicks.filter(c => c.button === 'left' || c.button === 'right');
  if (validClicks.length === 0) {
    return [];
  }

  // 按时间排序
  const sortedClicks = [...validClicks].sort((a, b) => a.time - b.time);

  const suggestions: ClickZoomSuggestion[] = [];

  let groupStartIndex = 0;

  for (let i = 0; i < sortedClicks.length; i++) {
    const currentClick = sortedClicks[i];
    const nextClick = sortedClicks[i + 1];

    // 检查是否需要结束当前分组
    const isLastClick = !nextClick;
    const shouldEndGroup = isLastClick || (nextClick.time - currentClick.time > mergeThresholdMs);

    if (shouldEndGroup) {
      // 结束当前分组，创建一个缩放建议
      const firstClick = sortedClicks[groupStartIndex];
      const lastClick = currentClick;
      const clickCount = i - groupStartIndex + 1;

      // 焦点使用第一次点击的位置
      // 优先使用源尺寸进行归一化（解决视频缩放导致的偏移问题）
      const widthBase = (mouseData.sourceWidth && mouseData.sourceWidth > 0) ? mouseData.sourceWidth : videoWidth;
      const heightBase = (mouseData.sourceHeight && mouseData.sourceHeight > 0) ? mouseData.sourceHeight : videoHeight;

      const normalizedX = Math.max(0, Math.min(1, firstClick.x / widthBase));
      const normalizedY = Math.max(0, Math.min(1, firstClick.y / heightBase));

      // 缩放从第一次点击开始，到最后一次点击后延续 defaultDurationMs
      suggestions.push({
        clickTime: firstClick.time,
        clickX: normalizedX,
        clickY: normalizedY,
        suggestedStartMs: firstClick.time,
        suggestedEndMs: lastClick.time + defaultDurationMs,
        button: firstClick.button,
        clickCount,
      });

      // 开始新分组
      groupStartIndex = i + 1;
    }
  }

  return suggestions;
}

