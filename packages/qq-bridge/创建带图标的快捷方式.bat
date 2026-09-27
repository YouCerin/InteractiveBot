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
rem  WHY the shortcut is named QQbot.lnk (ASCII) instead of a Chinese name
rem    It is the same name the project's own docs and the dev machine use, so
rem    there is exactly ONE name to remember and to keep in sync. An ASCII file
rem    name also avoids the codepage problem entirely: a Chinese file name has to
rem    be built from character codes here (see the note below), which is easy to
rem    get wrong and hard to read.
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
rem    3. The launcher's Chinese FILE NAME is therefore built from character
rem       codes: the five characters of "qi dong ji qi ren" below.
rem       (Spelled as hex so this file stays ASCII even in comments.)
rem ============================================================================

chcp 65001 >nul
rem 0.2.4: creates up to THREE shortcuts --
rem   DesktopBot.lnk   -> the desktop-window-only launcher .bat (Chinese file name;
rem                      the one most people want). A .bat cannot carry a custom
rem                      icon in Explorer, which is why shortcuts are generated.
rem   QQbot.lnk        -> the all-purpose launcher .bat
rem   InteractBot.lnk  -> app\InteractBot.exe directly (when the desktop app exists;
rem                      its icon is embedded in the exe by electron-builder)
rem The Chinese file names are built from character codes so this file stays pure
rem ASCII (cmd parses .bat with the system codepage; Chinese here would break it).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $d=$PWD.Path; $sh=New-Object -ComObject WScript.Shell; $launch=[char]0x542F+[char]0x52A8+[char]0x673A+[char]0x5668+[char]0x4EBA+'.bat'; if(-not (Test-Path -LiteralPath (Join-Path $d $launch))){$launch='start.bat'}; $desk=[char]0x684C+[char]0x9762+[char]0x7AEF+'bot'+[char]0x542F+[char]0x52A8+'.bat'; $l=$sh.CreateShortcut((Join-Path $d 'QQbot.lnk')); $l.TargetPath=(Join-Path $d $launch); $l.WorkingDirectory=$d; $l.IconLocation='assets\icon.ico,0'; $l.Description='InteractBot - QQ + DSH bridge'; $l.Save(); Write-Host ('OK -> QQbot.lnk'); if(Test-Path -LiteralPath (Join-Path $d $desk)){ $deskLnk=((($desk -replace '\.bat$','')) + '.lnk'); $l3=$sh.CreateShortcut((Join-Path $d $deskLnk)); $l3.TargetPath=(Join-Path $d $desk); $l3.WorkingDirectory=$d; $l3.IconLocation='assets\icon.ico,0'; $l3.Description='InteractBot desktop console (standalone window)'; $l3.Save(); Write-Host ('OK -> ' + $deskLnk) } else { Write-Host ('note: ' + $desk + ' not found, skipped its shortcut') }; $exe=Join-Path $d 'app\InteractBot.exe'; if(Test-Path -LiteralPath $exe){ $l2=$sh.CreateShortcut((Join-Path $d 'InteractBot.lnk')); $l2.TargetPath=$exe; $l2.WorkingDirectory=(Join-Path $d 'app'); $l2.Description='InteractBot desktop console (window + launcher)'; $l2.Save(); Write-Host ('OK -> InteractBot.lnk') } else { Write-Host 'note: app\InteractBot.exe not found, skipped InteractBot.lnk' }"

if errorlevel 1 (
  echo.
  echo [!] Failed to create the shortcut. See the message above.
) else (
  echo.
  rem NOTE the caret-escaped parentheses: an unescaped ")" inside an if-block
  rem CLOSES the block early, so the rest of the line is parsed as a command --
  rem cmd then prints "created was unexpected at this time" on the SUCCESS path.
  rem This file shipped like that until 0.2.4 (it only "worked" because the
  rem error was cosmetic and the shortcuts were already written).
  echo Shortcut^(s^) created in this folder. Right-click one, or drag it to the
  echo desktop, to keep it handy.
)
echo.
pause
