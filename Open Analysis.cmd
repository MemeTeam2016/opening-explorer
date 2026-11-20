@echo off
rem Starts the local server (needed for Stockfish analysis) and opens it in your browser.
rem Keep this window open while you use the page; close it to stop the server.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org, then try again. & pause & exit /b 1)
if not exist node_modules (echo First run: installing packages... & call npm install --no-audit --no-fund || (pause & exit /b 1))
node serve.mjs --open
pause
