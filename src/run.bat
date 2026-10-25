@echo off
cd /d "%~dp0"
python sb_combat_gui.py
if errorlevel 1 pause
