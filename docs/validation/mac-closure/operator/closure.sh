# Operator automation for docs/performance/local-mac-closure.md. Source after lib.sh.
# Every step uses the disposable fixture vaults only.
export PERF_BASELINE_COMMIT=6b3ae45589132a7c37da14e94a20a4668b2f28b9
: "${PERF_CANDIDATE_COMMIT:?set PERF_CANDIDATE_COMMIT to the full candidate commit}"
PERF_LOG="$PERF_REPORTS/operator-log.txt"
HOST_VAULT=tyo-bit # an already open window used only to ask Obsidian to open a fixture vault

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$PERF_LOG"; }

vault_state() { # NAME -> JSON with pid, session and readiness
  ob vault="$1" eval code="JSON.stringify({pid:process.pid,ready:app.workspace.layoutReady===true,git:app.plugins.plugins['obsidian-git']?.gitReady===true,ws:!!app.plugins.plugins['obsidian-workspaces']?.controller,active:(()=>{const c=app.plugins.plugins['obsidian-workspaces']?.controller;const s=c?.state;return s?{name:s.workspaces[s.activeId]?.name??null,journal:s.journal===null?null:'present',busy:c.busy}:null})()})" | sed 's/^=> //'
}

wait_ready() { # NAME [seconds]
  local name="$1" limit="${2:-60}" start=$SECONDS st
  while (( SECONDS - start < limit )); do
    st=$(vault_state "$name")
    if [[ "$st" == *'"ready":true'* && "$st" == *'"git":true'* && "$st" == *'"ws":true'* && "$st" == *'"busy":null'* ]]; then echo "$st"; return 0; fi
    nap 1
  done
  echo "not ready: $st"; return 1
}

close_vault() { # NAME
  ob vault="$1" eval code="setTimeout(()=>window.close(),150);'closing'" >/dev/null
  nap 4
}

open_vault() { # NAME
  ob vault="$HOST_VAULT" eval code="require('electron').ipcRenderer.sendSync('vault-open','$PERF_ROOT/$1',false)" >/dev/null
  nap 4
  wait_ready "$1" 90
}

plugin_off() { ob vault="$1" plugin:disable id="$2" filter=community >/dev/null; }
plugin_on() {
  ob vault="$1" eval code="(async()=>{await app.plugins.loadManifests();return 'ok'})()" >/dev/null
  ob vault="$1" plugin:enable id="$2" filter=community >/dev/null
}

install_build() { # NAME ROLE
  local name="$1" role="$2" dist
  if [[ "$role" == candidate ]]; then dist="$PERF_REPO/dist"; else dist="$PERF_ROOT/baseline-source/dist"; fi
  plugin_off "$name" workspaces-switch-benchmark
  plugin_off "$name" workspaces-quick-switcher-probe
  plugin_off "$name" obsidian-workspaces
  nap 1
  cp "$dist/main.js" "$dist/manifest.json" "$dist/styles.css" "$PERF_ROOT/$name/.obsidian/plugins/obsidian-workspaces/"
  plugin_on "$name" obsidian-workspaces
  local st; st=$(wait_ready "$name" 30) || { log "FAILED readiness after install: $st"; return 1; }
  local branch dirty
  branch=$(git -C "$PERF_ROOT/$name" branch --show-current)
  dirty=$(git -C "$PERF_ROOT/$name" status --porcelain)
  if [[ "$st" != *'"name":"Alpha"'* || "$st" != *'"journal":null'* || "$branch" != alpha || -n "$dirty" ]]; then
    log "FAILED precondition after install: $st branch=$branch dirty=[$dirty]"; return 1
  fi
  log "installed $role $(shasum -a 256 "$PERF_ROOT/$name/.obsidian/plugins/obsidian-workspaces/main.js" | cut -c1-64) in $name; $st"
}

# Focus the fixture window from inside the renderer, then use the native
# command palette with input events injected through Electron: Cmd+P, typed
# text, Enter. No CLI process runs while the palette is in use.
palette_run() { # NAME "Command palette text" "required text of the selected suggestion"
  ob vault="$1" eval code="(()=>{const e=require('electron').remote;const w=e.getCurrentWindow();const wc=e.getCurrentWebContents();const L=window.__operatorLog=[];const at=(ms,f)=>setTimeout(()=>{try{f()}catch(x){L.push('error '+x.message)}},ms);
at(1200,()=>{e.app.focus({steal:true});w.show();w.focus();window.focus();});
at(2200,()=>{L.push('focus '+w.isFocused()+'/'+document.hasFocus()+' modals '+document.querySelectorAll('.modal-container').length);wc.sendInputEvent({type:'keyDown',keyCode:'P',modifiers:['meta']});wc.sendInputEvent({type:'keyUp',keyCode:'P',modifiers:['meta']});});
at(3000,()=>{L.push('palette '+!!document.querySelector('.prompt'));wc.insertText($(printf '%s' "$2" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'));});
at(3900,()=>{const s=document.querySelector('.prompt .suggestion-item.is-selected');const t=s?s.innerText.replace(/\\s+/g,' '):'';L.push('selected '+t);if(!t.includes($(printf '%s' "$3" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'))){L.push('abort');wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});return;}wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});L.push('enter');});
return 'scheduled';})()" >/dev/null
}
operator_log() { ob vault="$1" eval code="JSON.stringify(window.__operatorLog??null)" | sed 's/^=> //'; }

run_report() { # NAME PROFILE SESSION ROLE
  local name="$1" profile="$2" s="$3" role="$4" commit
  if [[ "$role" == candidate ]]; then commit="$PERF_CANDIDATE_COMMIT"; else commit="$PERF_BASELINE_COMMIT"; fi
  local phase="$profile-s$s-$role" result="$PERF_REPORTS/$profile-s$s-$role.json"
  install_build "$name" "$role" || return 1
  (cd "$PERF_REPO" && node scripts/prepare-switch-benchmark.mjs "$PERF_ROOT/$name" --phase "$phase" --manual-start \
    --product-commit "$commit" --samples 100 --warmups 3 --baseline-samples 20 --result "$result") \
    > "$PERF_REPORTS/$phase.prepare.json" 2>&1 || { log "FAILED prepare $phase: $(tail -3 "$PERF_REPORTS/$phase.prepare.json")"; return 1; }
  log "prepared $phase probe=$(jget "$PERF_REPORTS/$phase.prepare.json" r.probeSHA256) product=$(jget "$PERF_REPORTS/$phase.prepare.json" r.expectedProductSHA256)"
  plugin_on "$name" workspaces-switch-benchmark
  nap 2
  palette_run "$name" "Workspaces Switch Latency Benchmark: Run switch benchmark" "Run switch benchmark"
  nap 6
  log "start $phase: $(operator_log "$name")"
  local st; st=$(wait_report "$result" 1500)
  log "finished $phase: $st"
  [[ "$st" == passed* ]]
}

run_session() { # NAME PROFILE SESSION FIRST_ROLE SECOND_ROLE
  local name="$1" profile="$2" s="$3"
  log "session $profile-$s: reopen $name ($4 then $5)"
  plugin_off "$name" workspaces-switch-benchmark
  plugin_off "$name" workspaces-quick-switcher-probe
  close_vault "$name"
  local st; st=$(open_vault "$name") || { log "FAILED open: $st"; return 1; }
  log "session $profile-$s renderer: $st"
  run_report "$name" "$profile" "$s" "$4" || return 1
  run_report "$name" "$profile" "$s" "$5" || return 1
}

run_safety() { # NAME PROFILE  (same renderer as the last measured pair)
  local name="$1" profile="$2"
  local result="$PERF_REPORTS/$profile-quick-switcher-fixed.json"
  install_build "$name" candidate || return 1
  (cd "$PERF_REPO" && node scripts/prepare-quick-switcher-probe.mjs "$PERF_ROOT/$name" --phase fixed \
    --quick-switcher-plugin "$PERF_ASSETS/quick-switcher") > "$PERF_REPORTS/$profile-safety.prepare.json" 2>&1 \
    || { log "FAILED safety prepare: $(tail -3 "$PERF_REPORTS/$profile-safety.prepare.json")"; return 1; }
  local produced; produced=$(jget "$PERF_REPORTS/$profile-safety.prepare.json" r.resultFile)
  ob vault="$name" eval code="(()=>{const e=require('electron').remote;setTimeout(()=>{e.app.focus({steal:true});const w=e.getCurrentWindow();w.show();w.focus();window.focus();},800);return 'focus scheduled'})()" >/dev/null
  nap 2
  plugin_on "$name" darlal-switcher-plus
  nap 2
  plugin_on "$name" workspaces-quick-switcher-probe
  local st; st=$(wait_report "$produced" 300)
  plugin_off "$name" workspaces-quick-switcher-probe
  [[ "$produced" != "$result" ]] && mv "$produced" "$result"
  log "safety $profile: $st probe=$(jget "$PERF_REPORTS/$profile-safety.prepare.json" r.probeSHA256) state=$(vault_state "$name")"
  [[ "$st" == passed* ]]
}

diag_run() { # NAME BUILD_DIR COMMIT PHASE SAMPLES [extra prepare flags...]
  local name="$1" dist="$2" commit="$3" phase="$4" samples="$5"; shift 5
  local result="$PERF_ROOT/diagnostics/$phase.json"
  local -a sampleArgs; [[ -n "$samples" ]] && sampleArgs=(--samples "$samples")
  plugin_off "$name" workspaces-switch-benchmark; plugin_off "$name" workspaces-quick-switcher-probe; plugin_off "$name" obsidian-workspaces; nap 1
  cp "$dist/main.js" "$dist/manifest.json" "$dist/styles.css" "$PERF_ROOT/$name/.obsidian/plugins/obsidian-workspaces/"
  plugin_on "$name" obsidian-workspaces; wait_ready "$name" 30 >/dev/null || { echo "not ready"; return 1; }
  (cd "$PERF_REPO" && node scripts/prepare-switch-benchmark.mjs "$PERF_ROOT/$name" --phase "$phase" --manual-start --product-commit "$commit" "$@" --warmups 3 --baseline-samples 6 --result "$result" "${sampleArgs[@]}") > "$PERF_ROOT/diagnostics/$phase.prepare.json" 2>&1 || { tail -3 "$PERF_ROOT/diagnostics/$phase.prepare.json"; return 1; }
  plugin_on "$name" workspaces-switch-benchmark; nap 2
  palette_run "$name" "Workspaces Switch Latency Benchmark: Run switch benchmark" "Run switch benchmark"; nap 6
  echo "$phase start: $(operator_log "$name")"
  echo "$phase: $(wait_report "$result" 900)"
}
summ() { # REPORT -> one line per group
  node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const d=(v)=>{v=v.filter(Number.isFinite).sort((a,b)=>a-b);const n=v.length;if(!n)return "n=0";const q=(p)=>v[Math.ceil(n*p)-1];return `n=${n} med=${((v[(n-1)>>1]+v[n>>1])/2).toFixed(1)} p95=${q(.95).toFixed(1)} p99=${q(.99).toFixed(1)} min=${v[0].toFixed(1)} max=${v[n-1].toFixed(1)}`};
const g={};for(const s of r.samples||[]){const k=s.temperature==="measured"?s.scenario:s.temperature+":"+s.scenario;(g[k]??=[]).push(s);}
console.log(process.argv[1].split("/").pop(), r.status, "product", r.environment?.plugins?.["obsidian-workspaces"]?.bundleSHA256?.slice(0,8), "pid", r.environment?.nativeSession?.processId ?? r.nativeSession?.processId);
for(const [k,v] of Object.entries(g)) console.log("  "+k.padEnd(28), d(v.map(s=>s.timingsMs?.selectionToControllerComplete)), "modals="+v.filter(s=>s.transitionModalOpened).length, "git="+[...new Set(v.map(s=>s.rawGitCommandCount))].join("/"));
' "$1"
}

observe() { # NAME -> JSON observation of the live native state
  ob vault="$1" eval code="(()=>{const leaves=[];app.workspace.iterateAllLeaves(l=>{const f=l.view?.file?.path;if(f)leaves.push({file:f,type:l.view.getViewType(),pinned:!!l.pinned,region:l.getRoot()===app.workspace.rootSplit?'main':l.getRoot()===app.workspace.leftSplit?'left':l.getRoot()===app.workspace.rightSplit?'right':'other',deferred:!!l.isDeferred,text:l.view.editor?.getValue?.().slice(0,60)??null})});const c=app.plugins.plugins['obsidian-workspaces'].controller;const s=c.state;return JSON.stringify({at:new Date().toISOString(),pid:process.pid,workspace:s.workspaces[s.activeId]?.name,journal:s.journal,activeFile:app.workspace.getActiveFile()?.path,statusBar:[...document.querySelectorAll('.status-bar-item')].map(e=>e.innerText.trim()).filter(Boolean),modals:document.querySelectorAll('.modal-container').length,leaves})})()" | sed 's/^=> //'
}
qpp_select() { # NAME WORKSPACE_NAME : real command palette -> Q++ workspace mode -> typed name -> Enter
  palette_run "$1" "Quick Switcher++: Open in Workspaces Mode" "Open in Workspaces Mode"
  nap 5.5
  ob vault="$1" eval code="(()=>{const e=require('electron').remote;const wc=e.getCurrentWebContents();const L=window.__operatorLog;const at=(ms,f)=>setTimeout(()=>{try{f()}catch(x){L.push('error '+x.message)}},ms);
at(600,()=>{L.push('qpp prompt '+!!document.querySelector('.prompt')+' focus '+document.hasFocus());wc.insertText('$2');});
at(1500,()=>{const s=document.querySelector('.prompt .suggestion-item.is-selected');L.push('qpp selected '+(s?s.innerText.replace(/\\s+/g,' '):''));wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});L.push('qpp enter');});
return 'scheduled';})()" >/dev/null
  nap 5
}
roundtrip() { # NAME PROFILE
  local name="$1" profile="$2"
  local out="$PERF_REPORTS/$profile-roundtrip.txt"
  { echo "# Command-palette roundtrip, $profile, input injected through Electron sendInputEvent/insertText (no human keyboard)"
    echo "start $(observe "$name") git=$(git -C "$PERF_ROOT/$name" branch --show-current)"
    qpp_select "$name" Beta
    echo "operator $(operator_log "$name")"
    echo "beta $(observe "$name") git=$(git -C "$PERF_ROOT/$name" branch --show-current) status=[$(git -C "$PERF_ROOT/$name" status --porcelain)]"
    ob vault="$name" dev:screenshot path="$PERF_REPORTS/$profile-roundtrip-beta.png" >/dev/null
    qpp_select "$name" Alpha
    echo "operator $(operator_log "$name")"
    echo "alpha $(observe "$name") git=$(git -C "$PERF_ROOT/$name" branch --show-current) status=[$(git -C "$PERF_ROOT/$name" status --porcelain)]"
    ob vault="$name" dev:screenshot path="$PERF_REPORTS/$profile-roundtrip-alpha.png" >/dev/null
  } > "$out" 2>&1
  log "roundtrip $profile recorded: $(grep -c . "$out") lines"
}
run_profile() { # PROFILE HOST_PROFILE
  local profile="$1"; HOST_VAULT="vault-$2"
  run_session "vault-$profile" "$profile" 1 baseline candidate || return 1
  run_session "vault-$profile" "$profile" 2 candidate baseline || return 1
  run_session "vault-$profile" "$profile" 3 baseline candidate || return 1
  run_safety "vault-$profile" "$profile" || return 1
  roundtrip "vault-$profile" "$profile"
}
