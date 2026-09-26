@echo off
rem ============================================================================
rem  Create a shortcut to the bot, carrying the custom icon, in this folder.
rem
rem  WHY this script exists
rem    Windows Explorer CANNOT show a custom icon on a .bat file. Double-clicking
rem    the launcher .bat works, but Explorer always draws the default
rem    white-paper-and-gears icon for it. Only a .lnk can carry a custom icon.
rem
rem  WHY the shortcut is generated here instead of shipped ready-made
rem    A .lnk stores ABSOLUTE paths. One built on the author's machine points at
rem    the author's folder, so on any other machine both the target and the icon
rem    break (the icon degrades to a blank page). Generating it on the machine
rem    that will use it keeps both paths correct.
rem
rem  WHY the icon is a RELATIVE path ('assets\icon.ico')
rem    Then moving this whole folder elsewhere does not break the icon.
rem
rem  IMPORTANT - THREE HARD-WON RULES ABOUT THIS FILE AND ITS HELPERS
rem    1. This .bat body must stay PURE ASCII. cmd parses .bat using the system
rem       codepage (GBK on Chinese Windows); Chinese text in a UTF-8 file
rem       swallows line breaks and corrupts parsing.
rem    2. The PowerShell text below must ALSO stay pure ASCII, comments included.
rem       Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as GBK, and a
rem       Chinese comment there silently eats the following code. This really
rem       happened: it produced "shortcut path must end with .lnk" errors,
rem       because the mangled comment destroyed the next statement.
rem    3. Chinese FILE NAMES are therefore built from character codes:
rem       the three characters of "ji qi ren" and the two of "qi dong" below.
rem       (Spelled as hex so this file stays ASCII even in comments.)
rem ============================================================================

chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $d=$PWD.Path; $lnk='QQ'+[char]0x673A+[char]0x5668+[char]0x4EBA+'.lnk'; $bat=[char]0x542F+[char]0x52A8+[char]0x673A+[char]0x5668+[char]0x4EBA+'.bat'; if(-not (Test-Path -LiteralPath (Join-Path $d $bat))){$bat='start.bat'}; $sh=New-Object -ComObject WScript.Shell; $l=$sh.CreateShortcut((Join-Path $d $lnk)); $l.TargetPath=(Join-Path $d $bat); $l.WorkingDirectory=$d; $l.IconLocation='assets\icon.ico,0'; $l.Description='InteractBot - QQ + DSH bridge'; $l.Save(); Write-Host ('OK -> ' + (Join-Path $d $lnk))"

if errorlevel 1 (
  echo.
  echo [!] Failed to create the shortcut. See the message above.
) else (
  echo.
  echo Shortcut created in this folder. Right-click it, or drag it to the
  echo desktop, to keep it handy.
)
echo.
pause
