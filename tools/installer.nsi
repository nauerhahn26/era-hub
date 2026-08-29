; installer.nsi — the one-file Windows front door (dad's 8/29 ruling: setup
; style; SignPath signs this artifact once the Foundation approves).
; Per-user everything: no admin prompt, installs to %LOCALAPPDATA%\New ERA,
; uninstall entry in Settings > Apps. App choice stays in the welcome wizard.
; Built by release.sh:  makensis -DPAYLOAD=<dir> -DOUTFILE=<exe> -DVERSION=<v>
Unicode true
!define APPNAME "New ERA"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewERA"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\New ERA"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open New ERA and pick your apps"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchHub
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchHub
  ExecShell "open" "$INSTDIR\start-hub.bat"
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}/*"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\start-hub.bat" "" "$INSTDIR\public\favicon.ico"
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\start-hub.bat" "" "$INSTDIR\public\favicon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "New ERA Communications"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "New ERA Communications"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\public\favicon.ico"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ExecWait 'taskkill /IM node.exe /F'
  ; everything but data\ — the family's content, settings, and history stay
  Delete "$INSTDIR\*.*"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\public"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$SMSTARTUP\${APPNAME}.lnk"
  ; per-app shortcuts the hub created from the wizard/toggles
  Delete "$DESKTOP\Making Words.lnk"
  Delete "$DESKTOP\The Pencil.lnk"
  Delete "$DESKTOP\Board.lnk"
  Delete "$DESKTOP\Music.lnk"
  Delete "$DESKTOP\Movies.lnk"
  Delete "$DESKTOP\Book Reader.lnk"
  Delete "$SMPROGRAMS\Making Words.lnk"
  Delete "$SMPROGRAMS\The Pencil.lnk"
  Delete "$SMPROGRAMS\Board.lnk"
  Delete "$SMPROGRAMS\Music.lnk"
  Delete "$SMPROGRAMS\Movies.lnk"
  Delete "$SMPROGRAMS\Book Reader.lnk"
  DeleteRegKey HKCU "${REGKEY}"
  RMDir "$INSTDIR"   ; removes only if empty (data kept = dir stays, by design)
SectionEnd
