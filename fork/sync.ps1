# Runs in the background after every launch: moves mine onto the newest safe upstream preview tag
# and makes sure a slot holds the tip of mine. Never touches the slot the app is running from.
. "$PSScriptRoot\lib.ps1"
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'

$lock = Enter-ForkLock 0
if (-not $lock) { exit 0 }
try {
  try { Invoke-Git $Repo fetch upstream --tags --prune --quiet | Out-Null } catch { Write-Log "fetch failed: $_" }

  $tag = Get-SyncTarget
  $state = Read-State
  if ($tag -and -not $state.attempted[$tag]) {
    $state.attempted[$tag] = (Get-Date -Format s)
    Save-State $state
    $mine = Invoke-Git $Repo rev-parse refs/heads/mine
    $base = Invoke-Git $Repo rev-parse refs/fork/base
    $tagCommit = Invoke-Git $Repo rev-parse "$tag^{commit}"
    Write-Log "rebasing mine onto $tag"
    Invoke-Git $SyncTree checkout --detach --force $mine | Out-Null
    $problem = $null
    if (Test-Git $SyncTree rebase --onto $tagCommit $base) {
      $new = Invoke-Git $SyncTree rev-parse HEAD
      $slot = Get-BuildSlot (Read-State)
      if (-not $slot) {
        Write-Log 'both slots are running; retrying on a later launch'
        $state = Read-State; $state.attempted.Remove($tag); Save-State $state
      } elseif (Build-Slot $slot $new) {
        Update-Mine $new $mine $tagCommit $base
        Set-ActiveSlot $slot
      } else {
        $problem = "The rebase applied cleanly but install, build or typecheck failed. Build log: $LogDir\build-$slot.log"
      }
    } else {
      Test-Git $SyncTree rebase --abort | Out-Null
      $problem = 'The rebase hit conflicts.'
    }
    if ($problem) {
      Start-ForkAgent "Fork sync: $tag" "fork-sync/$tag" @"
Automated T3 Code fork sync. Nobody is watching this thread, so do not ask questions; decide.

``mine`` ($mine) is built on upstream $base. Move it onto upstream preview tag $tag ($tagCommit):

    git rebase --onto $tagCommit $base

$problem

Resolve it following FORK.md: keep each patch's intent. If a patch can't be kept, drop it and
record why under "Dropped patches" in FORK.md. Then make sure typecheck and the tests for the
files you touched pass, and run:

    pwsh -NoProfile -File fork/ship.ps1 -Sync $tag -Expect $mine

If ship fails, fix the cause and run it again.
"@
    }
  }

  # Catch up: the app should open on the tip of mine.
  $mine = Invoke-Git $Repo rev-parse refs/heads/mine
  $state = Read-State
  $launch = Get-LaunchSlot $state
  if ($state.slots[$launch].commit -ne $mine) {
    $ready = $Slots | Where-Object { $state.slots[$_].commit -eq $mine } | Select-Object -First 1
    if ($ready) {
      Set-ActiveSlot $ready
    } else {
      $slot = Get-BuildSlot $state
      if ($slot -and (Build-Slot $slot $mine)) { Set-ActiveSlot $slot }
    }
  }
} catch {
  Write-Log "sync error: $_"
} finally {
  $lock.ReleaseMutex()
  $lock.Dispose()
}
