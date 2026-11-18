#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec /opt/homebrew/bin/node /Users/xuannguyen/.gemini/tools/antigravity-browser-host/bin/host.js "$@"
