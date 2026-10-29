; Custom NSIS include for the Windows installer (electron-builder `nsis.include`).
;
; Why this exists instead of electron-builder's `fileAssociations`: its APP_ASSOCIATE macro
; writes the DEFAULT value of HKCU\Software\Classes\.pdf, i.e. it makes this app the
; user's PDF handler, and its uninstaller never restores that value. Here the app is only
; REGISTERED as one of the programs that can open .pdf ("Open with" list). The user
; chooses the default in Windows Settings. Everything written below is removed again by
; the uninstaller. SHELL_CONTEXT is HKCU for a per-user install, HKLM for a per-machine one.
;
; Keys written (and removed on uninstall):
;   Software\Classes\.pdf\OpenWithProgids   value  <APP_ID>.pdf
;   Software\Classes\<APP_ID>.pdf           (whole key: description, icon, shell\open\command)
;
; Two guards beyond registration:
;  * A per-machine (all users) install registers the app in HKLM, where an administrator later launches it from
;    the ProgID. If $INSTDIR were user-writable, a standard user could replace the exe the administrator runs, so
;    a per-machine install is refused unless $INSTDIR is under $PROGRAMFILES64 (and contains no "..").
;    Checked at the earliest point (customInit: silent installs and /D=...) and again after the directory page
;    (customPageAfterChangeDir). A per-user install is unaffected.
;  * The uninstaller (customRemoveFiles) removes only what the installer puts in $INSTDIR, never the directory
;    tree: electron-builder's default `RMDir /r $INSTDIR` would also delete foreign files in a user-chosen folder.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${APP_ID}.pdf" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.pdf" "" "PDF Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.pdf\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.pdf\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.pdf\shell\open" "" "Open with ${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${APP_ID}.pdf\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${APP_ID}.pdf"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${APP_ID}.pdf"
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'
!macroend

; ---- per-machine install directory guard ---------------------------------------------------------------
; $installMode is "all" for a per-machine install (electron-builder multiUser.nsh), "CurrentUser" otherwise.
; Quit (not Abort): Abort in a custom page function only skips the page.
!macro customPageAfterChangeDir
  Function bentoCheckInstallDir
    Push $R5
    Push $R6
    Push $R8
    Push $R9
    ${If} $installMode == "all"
      StrLen $R8 "$PROGRAMFILES64\"
      StrCpy $R9 "$INSTDIR" $R8
      StrCmp $R9 "$PROGRAMFILES64\" bentoDotsStart bentoRejectDir
      bentoDotsStart:
      StrCpy $R6 0
      bentoScanDots:
        StrCpy $R5 "$INSTDIR" 2 $R6
        StrCmp $R5 "" bentoDirOk
        StrCmp $R5 ".." bentoRejectDir
        IntOp $R6 $R6 + 1
        Goto bentoScanDots
      bentoRejectDir:
        MessageBox MB_OK|MB_ICONSTOP "An all-users installation must be placed under $PROGRAMFILES64 (a folder only administrators can write to).$\r$\n$\r$\nChoose a folder under Program Files, or install for the current user only." /SD IDOK
        SetErrorLevel 5
        Quit
    ${EndIf}
    bentoDirOk:
    Pop $R9
    Pop $R8
    Pop $R6
    Pop $R5
  FunctionEnd

  Function bentoDirGuardPage
    Call bentoCheckInstallDir
    Abort ; nothing to show: skip this page
  FunctionEnd

  Page custom bentoDirGuardPage
!macroend

!macro customInit
  Call bentoCheckInstallDir
!macroend

; ---- uninstall: remove only what the installer put there --------------------------------------------------
; Replaces electron-builder's `RMDir /r $INSTDIR`. App-owned subfolders go whole; top-level files only by the
; names/patterns an Electron app ships; the folder itself only if it is then empty (RMDir without /r), so a
; foreign file in a user-chosen folder survives. packaging/windows/smoke-installer.sh proves it with a canary and
; fails if a file of the app is left behind (the pattern list below would then need an entry).
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\Uninstall *.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\uninstallerIcon.ico"
  RMDir "$INSTDIR"
!macroend
