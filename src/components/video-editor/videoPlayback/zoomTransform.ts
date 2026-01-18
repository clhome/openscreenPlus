import { Container, BlurFilter } from 'pixi.js';

interface TransformParams {
  cameraContainer: Container;
  blurFilter: BlurFilter | null;
  stageSize: { width: number; height: number };
  baseMask: { x: number; y: number; width: number; height: number };
  zoomScale: number;
  focusX: number;  // 归一化坐标 0-1，相对于视频内容
  focusY: number;  // 归一化坐标 0-1，相对于视频内容
  motionIntensity: number;
  isPlaying: boolean;
  motionBlurEnabled?: boolean;
}

export function applyZoomTransform({
  cameraContainer,
  blurFilter,
  stageSize,
  baseMask,
  zoomScale,
  focusX,
  focusY,
  motionIntensity,
  isPlaying,
  motionBlurEnabled = true,
}: TransformParams) {
  if (
    stageSize.width <= 0 ||
    stageSize.height <= 0 ||
    baseMask.width <= 0 ||
    baseMask.height <= 0
  ) {
    return;
  }

  // 焦点位置在舞台坐标中的实际像素位置
  // focusX/Y 是归一化坐标 (0-1)，相对于视频内容区域
  // 需要先转换到 baseMask（视频内容在舞台中的位置），再得到舞台坐标
  const focusStagePxX = baseMask.x + focusX * baseMask.width;
  const focusStagePxY = baseMask.y + focusY * baseMask.height;

  // Stage center (where we want the focus to end up after zoom)
  const stageCenterX = stageSize.width / 2;
  const stageCenterY = stageSize.height / 2;

  // Apply zoom scale to camera container
  cameraContainer.scale.set(zoomScale);

  // Calculate camera position to keep focus point centered
  // After scaling, the focus point moves to (focusX * zoomScale, focusY * zoomScale)
  // We want it at stage center, so offset = center - (focus * scale)
  const cameraX = stageCenterX - focusStagePxX * zoomScale;
  const cameraY = stageCenterY - focusStagePxY * zoomScale;

  cameraContainer.position.set(cameraX, cameraY);

  if (blurFilter) {
    const shouldBlur = motionBlurEnabled && isPlaying && motionIntensity > 0.0005;
    const motionBlur = shouldBlur ? Math.min(6, motionIntensity * 120) : 0;
    blurFilter.blur = motionBlur;
  }
}

