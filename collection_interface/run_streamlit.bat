@echo off
setlocal
cd /d "%~dp0"
uv run streamlit run src/collection_interface/app.py
