@echo off
cd /d %~dp0
call npm install
call npx pm2 start index.js --name "discordVCbot"
pause
