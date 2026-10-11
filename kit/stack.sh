#!/usr/bin/env bash
# Local dev stack for one ticket. Servers are detached, so they outlive the tool call that started them.
#   stack.sh up <KEY> <be-dir|-> <fe-dir|-> <be-port> <fe-port>
#   stack.sh status <be-port> <fe-port>
#   stack.sh down <be-port> <fe-port>
set -u
KIT="C:/Users/danus/.claude-kantor/kit"
EVID="E:/qonflo/.evidence"

guard() {
	for p in "$@"; do
		case "$p" in 3000|3001|5173) echo "REFUSED: port $p belongs to the user's own servers"; exit 2;; esac
	done
}
pid_on() { netstat -ano 2>/dev/null | grep -E "[:.]$1 +.*LISTENING" | awk '{print $NF}' | head -1; }
wait_up() {
	local port=$1 i=0
	while [ $i -lt 90 ]; do
		[ -n "$(pid_on "$port")" ] && { echo "UP $port (pid $(pid_on "$port"))"; return 0; }
		sleep 2; i=$((i + 1))
	done
	echo "TIMEOUT $port"; return 1
}

cmd=${1:-}; shift || true
# Linux: paths and protected ports come from paths.cjs, listeners are found with ss (lsof as fallback), detached servers get their own process group.
# guard and pid_on are replaced here, so status and wait_up run unchanged. up and down carry inline Windows commands and are handled here.
if [ "$(uname -s)" = Linux ]; then
	KIT=$(cd "$(dirname "$0")" && pwd -P)
	cfg() { node "$KIT/paths.cjs" --print | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((o,k)=>o[k],p);console.log(Array.isArray(v)?v.join(" "):v)' "$1"; }
	EVID=$(cfg evidence); PROTECTED=" $(cfg protectedPorts) "
	guard() {
		for p in "$@"; do
			case "$p" in ''|*[!0-9]*) echo "REFUSED: port \"$p\" is not a number"; exit 2;; esac
			case "$PROTECTED" in *" $p "*) echo "REFUSED: port $p belongs to the user's own servers"; exit 2;; esac
		done
	}
	pid_on() {
		if command -v ss > /dev/null 2>&1; then ss -H -ltnp "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1
		elif command -v lsof > /dev/null 2>&1; then lsof -ti ":$1" -sTCP:LISTEN 2>/dev/null | head -1
		fi
	}
	SETSID=""; command -v setsid > /dev/null 2>&1 && SETSID=setsid
	case "$cmd" in
		up)
			KEY=$1; BE=$2; FE=$3; BP=$4; FP=$5; guard "$BP" "$FP"
			mkdir -p "$EVID/$KEY/logs"
			if [ "$BE" != "-" ]; then
				if [ -n "$(pid_on "$BP")" ]; then echo "UP $BP (already)"; else
					(cd "$BE" && if [ -f pnpm-lock.yaml ]; then R="pnpm exec"; else R=npx; fi; PORT=$BP $SETSID nohup $R tsx --require "$KIT/ai-preload.cjs" src/core/app.ts > "$EVID/$KEY/logs/be.log" 2>&1 < /dev/null &)
				fi
			fi
			if [ "$FE" != "-" ]; then
				if [ -n "$(pid_on "$FP")" ]; then echo "UP $FP (already)"; else
					(cd "$FE" && if [ -f pnpm-lock.yaml ]; then R="pnpm exec"; else R=npx; fi; VITE_QONFLO_API_URL="http://localhost:$BP" WT_VITE_CACHE="$EVID/$KEY/vite-cache" $SETSID nohup $R vite --config "$KIT/vite.wt.config.mjs" --port "$FP" --strictPort > "$EVID/$KEY/logs/fe.log" 2>&1 < /dev/null &)
				fi
			fi
			rc=0
			[ "$BE" != "-" ] && { wait_up "$BP" || rc=1; }
			[ "$FE" != "-" ] && { wait_up "$FP" || rc=1; }
			exit $rc
			;;
		down)
			guard "$@"
			for p in "$@"; do
				pid=$(pid_on "$p")
				if [ -n "$pid" ]; then
					pg=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
					if [ -n "$pg" ] && [ "$pg" -gt 1 ] && [ "$pg" != "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" ]; then kill -TERM -- "-$pg" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; else kill -TERM "$pid" 2>/dev/null; fi
					echo "STOPPED $p"
				else echo "DOWN $p"; fi
			done
			exit 0
			;;
	esac
fi
case "$cmd" in
	up)
		KEY=$1; BE=$2; FE=$3; BP=$4; FP=$5; guard "$BP" "$FP"
		mkdir -p "$EVID/$KEY/logs"
		if [ "$BE" != "-" ]; then
			if [ -n "$(pid_on "$BP")" ]; then echo "UP $BP (already)"; else
				(cd "$BE" && PORT=$BP nohup npx tsx --require "$KIT/ai-preload.cjs" src/core/app.ts > "$EVID/$KEY/logs/be.log" 2>&1 &)
			fi
		fi
		if [ "$FE" != "-" ]; then
			if [ -n "$(pid_on "$FP")" ]; then echo "UP $FP (already)"; else
				(cd "$FE" && VITE_QONFLO_API_URL="http://localhost:$BP" WT_VITE_CACHE="$EVID/$KEY/vite-cache" nohup npx vite --config "$KIT/vite.wt.config.mjs" --port "$FP" --strictPort > "$EVID/$KEY/logs/fe.log" 2>&1 &)
			fi
		fi
		rc=0
		[ "$BE" != "-" ] && { wait_up "$BP" || rc=1; }
		[ "$FE" != "-" ] && { wait_up "$FP" || rc=1; }
		exit $rc
		;;
	status)
		for p in "$@"; do [ -n "$(pid_on "$p")" ] && echo "UP $p (pid $(pid_on "$p"))" || echo "DOWN $p"; done
		;;
	down)
		guard "$@"
		for p in "$@"; do
			pid=$(pid_on "$p")
			[ -n "$pid" ] && { taskkill //PID "$pid" //T //F > /dev/null 2>&1; echo "STOPPED $p"; } || echo "DOWN $p"
		done
		;;
	*) echo "usage: stack.sh up <KEY> <be-dir|-> <fe-dir|-> <be-port> <fe-port> | status <ports...> | down <ports...>"; exit 1;;
esac
