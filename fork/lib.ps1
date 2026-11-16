# Shared paths and helpers for the fork's launch, sync and ship scripts. See FORK.md.
$ErrorActionPreference = 'Stop'
# Text piped to git and node must not start with a byte-order mark.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Repo = Join-Path $env:USERPROFILE 'code\t3code'
$Root = Join-Path $env:USERPROFILE 'code\t3code-slots'
$BinDir = Join-Path $Root 'bin'
$LogDir = Join-Path $Root 'logs'
$SyncTree = Join-Path $Root 'sync'
$StatePath = Join-Path $Root 'state.json'
$DbPath = Join-Path $env:USERPROFILE '.t3\userdata\statev2.sqlite'
$TagPattern = 'v*-preview.*'
$Slots = @('a', 'b')

function Write-Log([string]$Message) {
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $line = '{0} [{1}] {2}' -f (Get-Date -Format s), $PID, $Message
  Add-Content -Path (Join-Path $LogDir 'fork.log') -Value $line
  Write-Host $line
}

function Invoke-Git([string]$Dir) {
  $ErrorActionPreference = 'Continue'
  $out = & git -C $Dir @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed in ${Dir}: $out" }
  $out
}

function Test-Git([string]$Dir) {
  & git -C $Dir @args *> $null
  $LASTEXITCODE -eq 0
}

function Read-State {
  $state = $null
  if (Test-Path $StatePath) { $state = Get-Content $StatePath -Raw | ConvertFrom-Json -AsHashtable }
  if (-not $state) { $state = @{} }
  foreach ($key in 'slots', 'attempted', 'failed') { if (-not $state[$key]) { $state[$key] = @{} } }
  if ($null -eq $state.push) { $state.push = $false }
  $state
}

function Save-State($State) {
  $tmp = "$StatePath.tmp"
  $State | ConvertTo-Json -Depth 5 | Set-Content $tmp
  Move-Item $tmp $StatePath -Force
}

# One sync or ship at a time. A crashed holder's mutex is abandoned, which counts as acquired.
function Enter-ForkLock([int]$TimeoutMinutes = 0) {
  $mutex = [System.Threading.Mutex]::new($false, 'Local\t3code-fork')
  try {
    if ($mutex.WaitOne([TimeSpan]::FromMinutes($TimeoutMinutes))) { return $mutex }
  } catch [System.Threading.AbandonedMutexException] {
    return $mutex
  }
  $mutex.Dispose()
  $null
}

# The slot the launcher starts: the active one if its build is good, otherwise any good one.
function Get-LaunchSlot($State) {
  if ($State.active -and $State.slots[$State.active]) { return $State.active }
  foreach ($slot in $Slots) { if ($State.slots[$slot]) { return $slot } }
  'a'
}

function Test-SlotBusy([string]$Slot) {
  $marker = (Join-Path $Root $Slot) + '\'
  [bool](Get-CimInstance Win32_Process -Filter "Name='electron.exe' or Name='node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) })
}

# Prefer the inactive slot; fall back to the active one when the running app sits in the other.
function Get-BuildSlot($State) {
  $active = Get-LaunchSlot $State
  $ordered = @($Slots | Where-Object { $_ -ne $active }) + $active
  foreach ($slot in $ordered) { if (-not (Test-SlotBusy $slot)) { return $slot } }
  $null
}

function Get-MigrationHead([string]$Ref) {
  $src = Invoke-Git $Repo show "${Ref}:apps/server/src/persistence/Migrations.ts"
  ($src | Select-String '^\s*\[(\d+),\s*"' | ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
    Measure-Object -Maximum).Maximum
}

function Get-DbMigrationHead {
  if (-not (Test-Path $DbPath)) { return 0 }
  $js = "const s=new (require('node:sqlite').DatabaseSync)(process.argv[1],{readOnly:true});" +
    "try{console.log(s.prepare('select max(migration_id) m from effect_sql_migrations').get().m??0)}catch{console.log(0)}"
  [int](& node --no-warnings -e $js $DbPath)
}

# Builds $Commit into $Slot. Returns $true only when install, build and typecheck all pass and the
# build knows every migration the live database has (an older build may not open it).
function Build-Slot([string]$Slot, [string]$Commit) {
  $state = Read-State
  if ($state.failed[$Commit]) { Write-Log "skip $Commit, its build already failed"; return $false }
  $dbHead = Get-DbMigrationHead
  $buildHead = Get-MigrationHead $Commit
  if ($buildHead -lt $dbHead) { Write-Log "refuse $Commit, migrations $buildHead < database $dbHead"; return $false }

  $wasActive = $state.active -eq $Slot
  $state.slots.Remove($Slot)
  if ($wasActive) { $state.active = Get-LaunchSlot $state }
  Save-State $state

  $dir = Join-Path $Root $Slot
  $log = Join-Path $LogDir "build-$Slot.log"
  Set-Content $log "build $Commit $(Get-Date -Format s)"
  Invoke-Git $dir checkout --detach --force $Commit | Out-Null
  Push-Location $dir
  try {
    $steps = @(
      @('install', '--frozen-lockfile'),
      # install skips Electron's own download; this fetches the runtime the launcher starts.
      @('--filter', '@t3tools/desktop', 'run', 'ensure:electron'),
      @('run', 'build:desktop'),
      @('run', 'typecheck')
    )
    foreach ($step in $steps) {
      Write-Log "slot ${Slot}: pnpm $($step -join ' ')"
      & corepack pnpm @step *>> $log
      if ($LASTEXITCODE -ne 0) {
        Write-Log "slot ${Slot}: pnpm $($step -join ' ') failed, see $log"
        $state = Read-State; $state.failed[$Commit] = (Get-Date -Format s); Save-State $state
        return $false
      }
    }
  } finally { Pop-Location }

  $missing = @('apps\desktop\node_modules\electron\dist\electron.exe', 'apps\desktop\dist-electron\main.cjs',
    'apps\server\dist\bin.mjs', 'apps\server\dist\client\index.html') |
    Where-Object { -not (Test-Path (Join-Path $dir $_)) }
  if ($missing) {
    Write-Log "slot ${Slot}: build is missing $($missing -join ', ')"
    $state = Read-State; $state.failed[$Commit] = (Get-Date -Format s); Save-State $state
    return $false
  }

  $state = Read-State
  $state.slots[$Slot] = @{ commit = $Commit; builtAt = (Get-Date -Format s); migrations = $buildHead }
  Save-State $state
  Write-Log "slot ${Slot}: built $Commit"
  $true
}

function Set-ActiveSlot([string]$Slot) {
  $state = Read-State
  $state.active = $Slot
  Save-State $state
  New-Item -ItemType Directory -Force $BinDir | Out-Null
  Copy-Item (Join-Path $Root "$Slot\fork\*.ps1") $BinDir -Force
  Write-Log "slot $Slot is active; it opens on the next launch"
}

# Moves mine and refs/fork/base together, only if neither moved since we read them.
function Update-Mine([string]$New, [string]$Old, [string]$NewBase, [string]$OldBase) {
  $tx = "start`nupdate refs/heads/mine $New $Old`nupdate refs/fork/base $NewBase $OldBase`ncommit`n"
  $tx | & git -C $Repo update-ref --stdin
  if ($LASTEXITCODE -ne 0) { throw 'mine moved while this ran; nothing was changed.' }
  Write-Log "mine $Old -> $New (base $NewBase)"
  if ((Read-State).push) {
    & git -C $Repo push --quiet --force-with-lease="mine:$Old" origin mine *>> (Join-Path $LogDir 'fork.log')
    if ($LASTEXITCODE -ne 0) { Write-Log 'push to origin failed; it will go with the next push' }
  }
}

# Newest preview tag that is newer than mine's base and safe for the live database, or $null.
function Get-SyncTarget {
  $base = Invoke-Git $Repo rev-parse refs/fork/base
  $tag = Invoke-Git $Repo tag -l $TagPattern |
    Sort-Object { [long]($_ -split '\.')[-2] }, { [long]($_ -split '\.')[-1] } -Descending |
    Select-Object -First 1
  if (-not $tag) { return $null }
  if (Test-Git $Repo merge-base --is-ancestor $tag $base) { return $null }
  $tagTime = [long](Invoke-Git $Repo log -1 --format=%ct "$tag^{commit}")
  $baseTime = [long](Invoke-Git $Repo log -1 --format=%ct $base)
  if ($tagTime -le $baseTime) { return $null }
  $tagHead = Get-MigrationHead $tag
  $dbHead = Get-DbMigrationHead
  if ($tagHead -lt $dbHead) { Write-Log "wait on $tag, migrations $tagHead < database $dbHead"; return $null }
  $tag
}

function Start-ForkAgent([string]$Title, [string]$Branch, [string]$Message) {
  $cli = Join-Path $Root "$(Get-LaunchSlot (Read-State))\apps\server\dist\bin.mjs"
  $out = $Message | & node $cli thread start $Repo - --title $Title --worktree mine --branch $Branch --json 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Log "could not start agent: $out"; return }
  Write-Log "agent started: $out"
}
