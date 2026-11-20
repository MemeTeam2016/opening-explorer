@echo off
rem Downloads new games from chess.com and Lichess (uses config.json).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org, then try again. & pause & exit /b 1)
if not exist node_modules (echo First run: installing packages... & call npm install --no-audit --no-fund || (pause & exit /b 1))
node download.mjs
pause
