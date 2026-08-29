; installer.nsi — the one-file Windows front door (dad's 8/29 rulings: setup
; style, and the app chooser lives IN the installer — tick what you want
; before anything installs; the same choices stay editable in Settings and
; on the home screen). SignPath signs this artifact once approved.
; Per-user everything: no admin prompt, %LOCALAPPDATA%\New ERA, uninstall
; entry in Settings > Apps.
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
!include "Sections.nsh"
!include "LogicLib.nsh"
!define MUI_COMPONENTSPAGE_TEXT_TOP "Choose the apps for this computer - only what you tick is installed. Add or remove apps any time from the home screen or Settings. (The ERAgaze eye-gaze engine joins this list in an upcoming release.)"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open New ERA now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchHub
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchHub
  ExecShell "open" "$INSTDIR\start-hub.bat"
FunctionEnd

Section "New ERA engine (required)" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; everything except the per-app packs (their dir names are unique in the tree)
  File /r /x pencil /x board /x reader "${PAYLOAD}/*"
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

; App checkboxes: only ticked apps' files land on disk (dad 8/29: really
; install what is chosen, never install-everything-and-hide). The selection
; also seeds data\apps.json (tiles + shortcuts). Enabling later downloads
; the missing pack from the release. Making Words rides with the core (its
; lesson engine is part of the hub root). Board, Music, and Movies share
; one pack, synced in .onSelChange.
Section "Making Words" SecMW
SectionEnd
Section "The Pencil" SecPencil
  SetOutPath "$INSTDIR\public"
  File /r "${PAYLOAD}/public/pencil"
SectionEnd
Section "Board" SecBoard
SectionEnd
Section "Music" SecMusic
SectionEnd
Section "Movies" SecMovies
SectionEnd
Section "Book Reader" SecReader
  SetOutPath "$INSTDIR\public"
  File /r "${PAYLOAD}/public/reader"
SectionEnd
Section "-board pack" SecBoardPack
  SetOutPath "$INSTDIR\public"
  File /r "${PAYLOAD}/public/board"
SectionEnd

Function .onSelChange
  StrCpy $2 0
  ${If} ${SectionIsSelected} ${SecBoard}
    StrCpy $2 1
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecMusic}
    StrCpy $2 1
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecMovies}
    StrCpy $2 1
  ${EndIf}
  ${If} $2 = 1
    !insertmacro SelectSection ${SecBoardPack}
  ${Else}
    !insertmacro UnselectSection ${SecBoardPack}
  ${EndIf}
FunctionEnd

Section "-writeApps"
  CreateDirectory "$INSTDIR\data"
  FileOpen $0 "$INSTDIR\data\apps.json" w
  FileWrite $0 '{"enabled":['
  StrCpy $1 ""
  ${If} ${SectionIsSelected} ${SecMW}
    FileWrite $0 '"making-words"'
    StrCpy $1 ","
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecPencil}
    FileWrite $0 '$1"pencil"'
    StrCpy $1 ","
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecBoard}
    FileWrite $0 '$1"board"'
    StrCpy $1 ","
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecMusic}
    FileWrite $0 '$1"music"'
    StrCpy $1 ","
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecMovies}
    FileWrite $0 '$1"movies"'
    StrCpy $1 ","
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecReader}
    FileWrite $0 '$1"reader"'
    StrCpy $1 ","
  ${EndIf}
  FileWrite $0 ']}'
  FileClose $0
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
