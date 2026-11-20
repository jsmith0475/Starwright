@echo off
rem Starwright launcher for Windows. Double-click this file.
rem It serves this folder on your own machine only and opens the game in your browser.
title Starwright
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\serve.ps1" %*
if errorlevel 1 pause
