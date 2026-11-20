#!/usr/bin/env sh
# kidze chart, macOS / Linux launcher. Same job as launch.cmd: start the server if it is not running,
# wait for it, open the page. The server quits by itself two minutes after the last page closes.
cd "$(dirname "$0")" || exit 1
PY="${DOLLARBARS_PY:-python3}"
URL=http://127.0.0.1:8793/

if ! curl -fs "${URL}ping" >/dev/null 2>&1; then
  nohup "$PY" server.py >/dev/null 2>&1 &
  i=0
  until curl -fs "${URL}ping" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
      echo "The server did not answer on port 8793 within 90 s. See logs/server.log."
      echo "If it says a module is missing:  $PY -m pip install -r requirements.txt"
      exit 1
    fi
    sleep 1
  done
fi

if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
else echo "Open $URL in a browser."
fi
