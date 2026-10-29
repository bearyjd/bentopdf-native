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
