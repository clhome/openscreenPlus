/**
 * 统一的错误处理工具
 * 将底层错误转化为用户友好的提示信息
 */

import { toast } from 'sonner';

// 错误类型定义
export type ErrorCategory = 
  | 'audio'      // 音频相关错误
  | 'video'      // 视频相关错误
  | 'recording'  // 录制相关错误
  | 'export'     // 导出相关错误
  | 'file'       // 文件操作错误
  | 'network'    // 网络相关错误
  | 'permission' // 权限相关错误
  | 'unknown';   // 未知错误

// 错误消息映射
const ERROR_MESSAGES: Record<string, { title: string; description: string; action?: string }> = {
  // 音频错误
  'NotFoundError_audio': {
    title: '未找到音频设备',
    description: '请检查麦克风是否已连接并正确配置',
    action: '请在系统设置中检查音频设备'
  },
  'NotAllowedError_audio': {
    title: '音频权限被拒绝',
    description: '应用需要麦克风权限才能录制音频',
    action: '请在系统设置中允许应用访问麦克风'
  },
  'NotReadableError_audio': {
    title: '音频设备被占用',
    description: '麦克风可能正被其他应用使用',
    action: '请关闭其他使用麦克风的应用后重试'
  },
  
  // 视频/屏幕捕获错误
  'NotFoundError_video': {
    title: '未找到录制源',
    description: '请选择要录制的屏幕或窗口',
  },
  'NotAllowedError_video': {
    title: '屏幕录制权限被拒绝',
    description: '应用需要屏幕录制权限',
    action: '请在系统设置中允许应用录制屏幕'
  },
  'AbortError': {
    title: '录制被中断',
    description: '录制过程中发生意外中断',
    action: '请重新开始录制'
  },
  
  // 导出错误
  'export_failed': {
    title: '导出失败',
    description: '视频导出过程中发生错误',
    action: '请检查磁盘空间后重试'
  },
  'export_cancelled': {
    title: '导出已取消',
    description: '用户取消了导出操作',
  },
  
  // 文件错误
  'file_save_failed': {
    title: '保存失败',
    description: '无法保存文件到指定位置',
    action: '请检查磁盘空间和写入权限'
  },
  'file_read_failed': {
    title: '读取失败',
    description: '无法读取文件',
    action: '请检查文件是否存在且未被占用'
  },
  
  // 通用错误
  'unknown': {
    title: '发生错误',
    description: '操作过程中发生未知错误',
    action: '请重试，如问题持续请联系支持'
  }
};

/**
 * 解析错误并返回用户友好的消息
 */
function parseError(error: unknown, category: ErrorCategory): { title: string; description: string; action?: string } {
  // 处理 DOMException
  if (error instanceof DOMException) {
    const key = `${error.name}_${category}`;
    if (ERROR_MESSAGES[key]) {
      return ERROR_MESSAGES[key];
    }
    if (ERROR_MESSAGES[error.name]) {
      return ERROR_MESSAGES[error.name];
    }
  }
  
  // 处理普通 Error
  if (error instanceof Error) {
    // 检查是否有匹配的错误消息
    const errorMessage = error.message.toLowerCase();
    
    if (errorMessage.includes('permission') || errorMessage.includes('denied')) {
      return ERROR_MESSAGES[`NotAllowedError_${category}`] || ERROR_MESSAGES['unknown'];
    }
    
    if (errorMessage.includes('not found') || errorMessage.includes('no device')) {
      return ERROR_MESSAGES[`NotFoundError_${category}`] || ERROR_MESSAGES['unknown'];
    }
    
    if (errorMessage.includes('busy') || errorMessage.includes('in use') || errorMessage.includes('occupied')) {
      return ERROR_MESSAGES[`NotReadableError_${category}`] || ERROR_MESSAGES['unknown'];
    }
  }
  
  return ERROR_MESSAGES['unknown'];
}

/**
 * 显示错误提示
 */
export function showError(error: unknown, category: ErrorCategory = 'unknown') {
  const { title, description, action } = parseError(error, category);
  
  // 在控制台记录详细错误（仅开发环境）
  if (process.env.NODE_ENV === 'development') {
    console.error(`[${category}] ${title}:`, error);
  }
  
  // 显示用户友好的提示
  toast.error(title, {
    description: action ? `${description}\n${action}` : description,
    duration: 5000,
  });
}

/**
 * 显示警告提示
 */
export function showWarning(message: string, description?: string) {
  toast.warning(message, {
    description,
    duration: 4000,
  });
}

/**
 * 显示成功提示
 */
export function showSuccess(message: string, description?: string) {
  toast.success(message, {
    description,
    duration: 3000,
  });
}

/**
 * 显示信息提示
 */
export function showInfo(message: string, description?: string) {
  toast.info(message, {
    description,
    duration: 3000,
  });
}

/**
 * 包装异步函数，自动处理错误
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  category: ErrorCategory = 'unknown'
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      showError(error, category);
      throw error;
    }
  }) as T;
}
