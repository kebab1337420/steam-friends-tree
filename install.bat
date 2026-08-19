@echo off
setlocal enabledelayedexpansion
rem Installs Steam Friends Tree into the Millennium plugins folder.
rem Run it from the folder it sits in, either from a release archive or from a
rem clone (where it builds the frontend first). Steam has to be closed.

echo Steam Friends Tree - installation
echo.

set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

rem --- Steam, from the registry, with the usual paths as a fallback ----------
rem An explicit folder as first argument wins over anything found below.
set "STEAM=%~1"
if not defined STEAM for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Valve\Steam" /v SteamPath 2^>nul') do set "STEAM=%%B"
if defined STEAM set "STEAM=!STEAM:/=\!"
if "!STEAM:~-1!"=="\" set "STEAM=!STEAM:~0,-1!"
if not exist "!STEAM!\steam.exe" (
	if not "%~1"=="" goto :nosteam
	for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\WOW6432Node\Valve\Steam" /v InstallPath 2^>nul') do set "STEAM=%%B"
)
if not exist "!STEAM!\steam.exe" set "STEAM=%ProgramFiles(x86)%\Steam"
if not exist "!STEAM!\steam.exe" set "STEAM=%ProgramFiles%\Steam"
:nosteam
if not exist "!STEAM!\steam.exe" (
	echo Steam introuvable. Passe son dossier en argument :
	echo     install.bat "D:\Jeux\Steam"
	goto :fail
)
echo Steam       : !STEAM!

if not exist "!STEAM!\millennium" (
	echo.
	echo Millennium n'est pas installe dans ce Steam : voir https://steambrew.app
	goto :fail
)

rem --- Steam must not be running, or the plugin loads the old files ----------
tasklist /fi "imagename eq steam.exe" 2>nul | find /i "steam.exe" >nul
if not errorlevel 1 (
	echo.
	echo Steam est ouvert. Ferme-le puis relance ce script.
	goto :fail
)

rem --- A clone still needs its bundles built --------------------------------
if not exist "%SRC%\.millennium\Dist\index.js" (
	if exist "%SRC%\package.json" (
		echo Bundles absents : construction avec npm...
		pushd "%SRC%"
		call npm install || (popd & goto :npmfail)
		call npm run build || (popd & goto :npmfail)
		popd
	)
)
if not exist "%SRC%\.millennium\Dist\index.js" (
	echo.
	echo .millennium\Dist\index.js manquant : archive incomplete.
	goto :fail
)

set "DEST=!STEAM!\millennium\plugins\steam-friends-tree"
echo Destination : !DEST!
echo.

mkdir "!DEST!\backend" 2>nul
mkdir "!DEST!\.millennium\Dist" 2>nul

rem config.json holds the Web API key and the saved settings: never touched.
copy /y "%SRC%\plugin.json" "!DEST!\" >nul || goto :copyfail
copy /y "%SRC%\README.md" "!DEST!\" >nul
copy /y "%SRC%\backend\main.lua" "!DEST!\backend\" >nul || goto :copyfail
copy /y "%SRC%\backend\export_template.html" "!DEST!\backend\" >nul || goto :copyfail
copy /y "%SRC%\.millennium\Dist\index.js" "!DEST!\.millennium\Dist\" >nul || goto :copyfail
copy /y "%SRC%\.millennium\Dist\webkit.js" "!DEST!\.millennium\Dist\" >nul || goto :copyfail

echo Installe.
echo.
if exist "!DEST!\config.json" (
	echo Cle Web API et reglages conserves.
) else (
	echo Au premier lancement, la page demande une cle Web API :
	echo     https://steamcommunity.com/dev/apikey
)
echo.
echo Lance Steam, active le plugin dans Millennium, onglet "Arbre des amis".
goto :done

:npmfail
echo.
echo La construction npm a echoue. Installe Node.js, ou prends l'archive de la release.
goto :fail

:copyfail
echo.
echo Copie impossible. Relance ce script en tant qu'administrateur
echo (clic droit ^> Executer en tant qu'administrateur).
goto :fail

:fail
echo.
pause
exit /b 1

:done
echo.
pause
exit /b 0
