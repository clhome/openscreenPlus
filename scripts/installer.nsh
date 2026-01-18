!macro customInit
  ; 强制关闭正在运行的程序
  nsExec::Exec 'taskkill /F /IM "OpenScreen 中文版.exe"'
  nsExec::Exec 'taskkill /F /IM "OpenScreen-Chinese.exe"'
  nsExec::Exec 'taskkill /F /IM "openscreen.exe"'
!macroend
