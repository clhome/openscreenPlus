import type { ZoomFocus } from "../types";

export const DEFAULT_FOCUS: ZoomFocus = { cx: 0.5, cy: 0.5 };
export const TRANSITION_WINDOW_MS = 600;
export const SMOOTHING_FACTOR = 0.05;
export const MIN_DELTA = 0.0001;
export const VIEWPORT_SCALE = 0.8;
