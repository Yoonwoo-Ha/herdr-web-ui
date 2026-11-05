; The desktop app replaces Ovis for Windows (app/windows, the one-file setup app):
; replace-old-setup.ps1 closes that app's windows and takes its shortcuts off the PC, and its copy and
; sign-in start too unless herdr says the Ovis plugin is installed (then they keep starting herdr's server
; at sign-in). herdr, the Ovis server and their state stay as they are. customInstall runs after this app's Start
; menu shortcut is made; when that shortcut was one of that app's (an update keeps the shortcut it
; finds) and the script removed it, it is made again here. One the user deleted stays deleted.

!macro customInstall
  StrCpy $1 "0"
  ${if} ${FileExists} "$newStartMenuLink"
    StrCpy $1 "1"
  ${endIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\replace-old-setup.ps1" "${PROJECT_DIR}\windows\replace-old-setup.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\replace-old-setup.ps1" -NewExe "$appExe"'
  Pop $0
  ; a failed step leaves that app's rest as it was: nothing of this app's depends on it
  DetailPrint "Replacing Ovis for Windows: $0"
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${if} $1 == "1"
    ${andIfNot} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  !endif
!macroend
