import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';

// 获取系统语言
function getSystemLanguage(): string {
  // 优先使用 navigator.language（浏览器/Electron 环境）
  const browserLang = navigator.language || navigator.languages?.[0] || '';
  
  // 如果是中文（zh、zh-CN、zh-TW、zh-HK 等），返回 'zh'
  if (browserLang.toLowerCase().startsWith('zh')) {
    return 'zh';
  }
  
  // 其他情况返回英文
  return 'en';
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      zh: { translation: zh },
      en: { translation: en }
    },
    lng: getSystemLanguage(), // 自动检测系统语言
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    }
  });

export default i18n;
