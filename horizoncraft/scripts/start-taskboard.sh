#!/usr/bin/env bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
cd "$(dirname "$0")/../taskboard" && exec node server.js
