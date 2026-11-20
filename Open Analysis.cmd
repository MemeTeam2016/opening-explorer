@echo off
rem Starts the local server (needed for Stockfish analysis) and opens it in your browser.
rem Keep this window open while you use the page; close it to stop the server.
cd /d "%~dp0"
node serve.mjs --open
pause
