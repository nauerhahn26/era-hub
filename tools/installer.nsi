; installer.nsi — the one-file Windows front door (dad's 8/29 rulings: setup
; style, and the app chooser lives IN the installer — tick what you want
; before anything installs; the same choices stay editable in Settings and
; on the home screen). Signing: tools/sign-installer.sh runs on the uninstaller
; stub and on the finished Setup.exe (no-op until the Certum cert lands).
; Per-user everything: no admin prompt, %LOCALAPPDATA%\Our Era Comms, uninstall
; entry in Settings > Apps. Renamed from New ERA on 9/26 (docs/superpowers/specs/
; 2026-09-26-rename-our-era-comms-design.md, R1): .onInit moves an old install's
; folder over and leaves a junction behind; the old names below are that path.
; Built by release.sh:  makensis -DPAYLOAD=<dir> -DOUTFILE=<exe> -DVERSION=<v>
Unicode true
!define APPNAME "Our Era Comms"
!define FULLNAME "Our Era Communication Tools"
!define PUBLISHER "Our Era Foundation"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OurEraComms"
; the pre-rename install (R1 keep-list): only .onInit and the uninstaller use these
!define OLDNAME "New ERA"
!define OLDREGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NewERA"

Name "${APPNAME}"
OutFile "${OUTFILE}"
!ifdef SIGN
  !uninstfinalize '"${SIGN}" "%1"'
  !finalize '"${SIGN}" "%1"'
!endif
InstallDir "$LOCALAPPDATA\${APPNAME}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 16   ; modest dictionary: the default crashed makensis (bus error) on the build box

!include "MUI2.nsh"
!include "Sections.nsh"
!include "LogicLib.nsh"
; Sizes come from build-dist.sh (du over the payload) so the description box
; can say where the megabytes are: dad unticked Music/Movies/Book Reader on
; 9/3 and "Space required" did not move - correctly, the engine is ~80 MB and
; those apps are under 1 MB each, but nothing on the page said so.
!ifndef SZ_CORE
  !define SZ_CORE "about 85"
!endif
!ifndef SZ_BOARD
  !define SZ_BOARD "about 20"
!endif
!ifndef SZ_MEDIA
  !define SZ_MEDIA "about 18"
!endif
!define MUI_COMPONENTSPAGE_TEXT_TOP "Choose the apps for this computer - only what you tick is installed. Add or remove apps any time from the home screen or Settings. Most of the space is the engine (${SZ_CORE} MB); the apps themselves are small."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APPNAME} now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchHub
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchHub
  ExecShell "open" "$INSTDIR\start-hub.bat" "" SW_SHOWMINIMIZED   ; no black console at first launch
FunctionEnd

; Upgrade over a New ERA install (R1). Self-update cannot move the folder it runs
; from (it is an in-process overlay), so the move happens HERE, before a single
; file is written, while nothing runs from it: stop the hub, the gaze engine and
; our own kiosk (its Edge profile lives in data\ and holds files open), rename
; the whole folder (data\ rides along untouched), and leave a junction at the old
; path so every TD Snap tile, Startup entry and per-app shortcut that still names
; it keeps working until the boot pass rewrites them. Then the old uninstall
; entry and the old-name shortcuts go, so Apps & features shows ONE entry. If the
; rename fails (a window open on that folder, a file in use) nothing has moved:
; say so and stop - never half an install in each folder. /SD keeps a silent
; install from waiting on the box. wmic, never a scripted shell (Defender, 8/29);
; nsExec runs it without cmd, so the LIKE wildcard is one plain percent sign.
Function .onInit
  ${If} ${FileExists} "$LOCALAPPDATA\${OLDNAME}\start-hub.bat"
  ${AndIfNot} ${FileExists} "$LOCALAPPDATA\${APPNAME}\*.*"
    nsExec::ExecToLog 'taskkill /IM node.exe /F'
    Pop $0
    nsExec::ExecToLog 'taskkill /IM ERAgaze.exe /F'
    Pop $0
    nsExec::ExecToLog `wmic process where "(name='msedge.exe' or name='chrome.exe') and commandline like '%kiosk-profile%'" call terminate`
    Pop $0
    Sleep 1500
    ClearErrors
    Rename "$LOCALAPPDATA\${OLDNAME}" "$LOCALAPPDATA\${APPNAME}"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "${APPNAME} could not move your ${OLDNAME} folder to its new name, because something still has it open (an app window, or a folder window showing it).$\r$\n$\r$\nClose everything, then run this installer again. Nothing was moved and your data is safe." /SD IDOK
      Abort
    ${EndIf}
    nsExec::ExecToLog 'cmd /c mklink /J "$LOCALAPPDATA\${OLDNAME}" "$LOCALAPPDATA\${APPNAME}"'
    Pop $0
    DeleteRegKey HKCU "${OLDREGKEY}"
    Delete "$DESKTOP\${OLDNAME}.lnk"
    Delete "$SMPROGRAMS\${OLDNAME}.lnk"
    Delete "$SMSTARTUP\${OLDNAME}.lnk"
  ${EndIf}
FunctionEnd

Section "${APPNAME} engine (required)" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; everything except the per-app packs (their names are unique in the tree;
  ; the list mirrors packs.js — tests/packs.test.mjs keeps them equal)
  File /r /x pencil /x board /x reader /x onnxruntime-web /x models /x libheif.js /x yt-dlp "${PAYLOAD}/*"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\start-hub.bat" "" "$INSTDIR\public\favicon.ico"
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\start-hub.bat" "" "$INSTDIR\public\favicon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${FULLNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "${PUBLISHER}"
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
Section "ERA eye gaze (recommended)" SecGaze
SectionEnd
Section "Making Words" SecMW
SectionEnd
Section "The Pencil" SecPencil
  SetOutPath "$INSTDIR\public"
  File /r "${PAYLOAD}/public/pencil"
SectionEnd
Section "Clothing Picker" SecBoard
SectionEnd
Section "Music" SecMusic
SectionEnd
Section "Movies" SecMovies
SectionEnd
Section "Book Reader" SecReader
  SetOutPath "$INSTDIR\public"
  File /r "${PAYLOAD}/public/reader"
SectionEnd
; The board pack carries the Clothing Picker's garment cut-out too (ONNX
; runtime + model + HEIC decoder, ~21 MB) so unticking Clothing/Music/Movies
; visibly shrinks "Space required" (dad 9/3: "the size stays the same").
Section "-board pack" SecBoardPack
  SetOutPath "$INSTDIR\public"
  File /r "${PAYLOAD}/public/board"
  SetOutPath "$INSTDIR\vendor"
  File /r "${PAYLOAD}/vendor/onnxruntime-web"
  File /r "${PAYLOAD}/vendor/models"
  File "${PAYLOAD}/vendor/libheif.js"
SectionEnd
; Off by default: Music plays the songs already in the family's folder without
; it. Tick it here to add songs from the web straight away, or leave it - the
; "+ Add a song" sheet offers the same download in one click later.
Section /o "Add songs from the web" SecMedia
  SetOutPath "$INSTDIR\vendor"
  File /r "${PAYLOAD}/vendor/yt-dlp"
SectionEnd

; Hover text on the components page: what each tick costs, and why the
; total barely moves for most of them.
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "The ${APPNAME} hub with its own bundled runtime - ${SZ_CORE} MB, and the only big part. Every app runs on it."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecGaze} "ERAgaze: a steady, gentle eye-gaze cursor tuned for kids. For PCs without their own gaze software. Under 1 MB."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMW} "Making Words: the daily letter lesson. Part of the engine - no extra space."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPencil} "The Pencil: free writing with word prediction. Under 1 MB."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecBoard} "Clothing Picker: today's outfit from the child's real wardrobe. Shares a ${SZ_BOARD} MB photo cut-out pack with Music and Movies - the pack is skipped only when all three are unticked."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMusic} "Music: favorite songs on big picture tiles. Shares the ${SZ_BOARD} MB pack with Clothing Picker and Movies."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMovies} "Movies: the family's films, one look to play. Shares the ${SZ_BOARD} MB pack with Clothing Picker and Music."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecReader} "Book Reader: page-by-page books with gaze. Under 1 MB (books live in your data folder)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMedia} "Lets Music's + Add button fetch a song from a web link - ${SZ_MEDIA} MB for the downloader. Not needed to play the songs already in your folder, and you can add it later from Music."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

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
  ${If} ${SectionIsSelected} ${SecGaze}
    FileWrite $0 '$1"eragaze"'
    StrCpy $1 ","
  ${EndIf}
  FileWrite $0 ']}'
  FileClose $0
SectionEnd

Section "Uninstall"
  ExecWait 'taskkill /IM node.exe /F'
  ExecWait 'taskkill /IM ERAgaze.exe /F'
  ; The junction .onInit left at the old path (New ERA -> Our Era Comms). Decided
  ; BEFORE the files go, while start-hub.bat still resolves through it: the old
  ; path answers with our start-hub.bat only when it leads here. Removed below
  ; with a plain RMDir, which on a junction removes the link and never follows
  ; it, and on a real folder with anything in it does nothing at all.
  StrCpy $R9 0
  ${If} "$INSTDIR" == "$LOCALAPPDATA\${APPNAME}"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\${OLDNAME}\start-hub.bat"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\${APPNAME}\start-hub.bat"
    StrCpy $R9 1
  ${EndIf}
  ; everything but data\ — the family's content, settings, and history stay
  Delete "$INSTDIR\*.*"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\public"
  RMDir /r "$INSTDIR\gaze"
  RMDir /r "$INSTDIR\vendor"   ; was left behind (21 MB) before 9/3
  Delete "$DESKTOP\ERAgaze.lnk"
  Delete "$DESKTOP\ERAgaze eye-gaze engine.lnk"
  Delete "$SMPROGRAMS\ERAgaze.lnk"
  Delete "$SMSTARTUP\ERAgaze.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$SMSTARTUP\${APPNAME}.lnk"
  Delete "$DESKTOP\${OLDNAME}.lnk"      ; the pre-rename names, on a PC the
  Delete "$SMPROGRAMS\${OLDNAME}.lnk"   ; boot pass never reached
  Delete "$SMSTARTUP\${OLDNAME}.lnk"
  ; per-app shortcuts the hub created from the wizard/toggles
  Delete "$DESKTOP\Making Words.lnk"
  Delete "$DESKTOP\The Pencil.lnk"
  Delete "$DESKTOP\Board.lnk"
  Delete "$DESKTOP\Clothing Picker.lnk"
  Delete "$DESKTOP\Music.lnk"
  Delete "$DESKTOP\Movies.lnk"
  Delete "$DESKTOP\Book Reader.lnk"
  Delete "$SMPROGRAMS\Making Words.lnk"
  Delete "$SMPROGRAMS\The Pencil.lnk"
  Delete "$SMPROGRAMS\Board.lnk"
  Delete "$SMPROGRAMS\Clothing Picker.lnk"
  Delete "$SMPROGRAMS\Music.lnk"
  Delete "$SMPROGRAMS\Movies.lnk"
  Delete "$SMPROGRAMS\Book Reader.lnk"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "${OLDREGKEY}"
  ${If} $R9 == 1
    RMDir "$LOCALAPPDATA\${OLDNAME}"   ; the junction only (see the top of this section)
  ${EndIf}
  RMDir "$INSTDIR"   ; removes only if empty (data kept = dir stays, by design)
SectionEnd
