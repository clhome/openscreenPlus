!macro customInit
  ; 强制关闭正在运行的程序（包括旧版本和新版本）
  nsExec::Exec 'taskkill /F /IM "OpenScreenPlus.exe"'
  nsExec::Exec 'taskkill /F /IM "OpenScreen 中文版.exe"'
  nsExec::Exec 'taskkill /F /IM "OpenScreen-Chinese.exe"'
  nsExec::Exec 'taskkill /F /IM "openscreen.exe"'
!macroend
