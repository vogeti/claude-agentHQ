@echo off
rem Starts the dashboard and opens it; close this window to stop it.
cd /d "%~dp0"
start "" http://agent-hq.localhost:4319
node server.js
