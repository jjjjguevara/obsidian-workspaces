# Operator helpers for the local Mac closure runbook. Source this file.
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
export PERF_ROOT="$HOME/Workspaces-performance"
export PERF_REPO="$PERF_ROOT/repo"
export PERF_REPORTS="$PERF_ROOT/reports"
export PERF_ASSETS="$PERF_ROOT/assets"

# Obsidian CLI call with a hard timeout (seconds, default 25).
ob() { perl -e 'alarm shift; exec @ARGV' "${OB_TIMEOUT:-25}" obsidian "$@" 2>&1; }
nap() { perl -e 'select(undef,undef,undef,shift)' "$1"; }

# Bring the named vault window to the front and give its document focus.
focus_vault() {
  osascript -e 'tell application "Obsidian" to activate' >/dev/null 2>&1
  ob vault="$1" eval code="(()=>{const w=require('electron').remote.getCurrentWindow(); w.show(); w.focus(); window.focus(); return JSON.stringify({focused:w.isFocused(), doc:document.hasFocus(), visible:document.visibilityState, pid:process.pid});})()"
}

# Read a JSON field path from a file: jget FILE 'expr using r'
jget() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(eval(process.argv[2]))' "$1" "$2"; }

# Wait until a report file reaches a terminal status. wait_report FILE [timeout_s]
wait_report() {
  local file="$1" limit="${2:-900}" start=$SECONDS st
  while (( SECONDS - start < limit )); do
    st=$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((r.kind==="benchmark-progress"?"progress:":"")+r.status+(r.completedSamples!==undefined?":"+r.completedSamples:""))}catch(e){console.log("unreadable")}' "$file")
    case "$st" in passed*|failed*|inconclusive*) echo "$st"; return 0;; esac
    nap 3
  done
  echo "timeout:$st"; return 1
}
