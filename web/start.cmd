@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    python -m venv .venv
    if errorlevel 1 goto failed
)
if not exist ".venv\audio-ready" (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto failed
    type nul > ".venv\audio-ready"
)
echo Open http://127.0.0.1:8765 in Chrome.
".venv\Scripts\python.exe" -B -m uvicorn app:app --host 127.0.0.1 --port 8765
if errorlevel 1 goto failed
exit /b 0
:failed
echo Could not start the audio extractor. Check the error above.
pause
exit /b 1
