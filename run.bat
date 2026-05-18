@echo off
echo Installing dependencies...
pip install -r requirements.txt
echo.
echo Starting Flight...
echo Open http://localhost:5000 in your browser
echo Admin login: zer0tune / zxcfriday15
echo.
python app.py
pause
