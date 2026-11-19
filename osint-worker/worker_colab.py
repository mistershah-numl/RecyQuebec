#!/usr/bin/env python3
"""
RECYC OSINT Worker for Google Colab

Runs the complete, production-grade main.app with all endpoints:
  GET  /health
  POST /render
  POST /osint
  POST /verify
  POST /smtp/test
  POST /smtp/send

Usage in Colab:
  !python worker_colab.py
"""
import os
import uvicorn
from main import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
