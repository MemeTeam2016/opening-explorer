@echo off
rem Downloads new games from chess.com and Lichess (uses config.json).
cd /d "%~dp0"
node download.mjs
pause
