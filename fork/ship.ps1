# Ships the current worktree's HEAD as the new mine: builds it into a free slot, moves mine, and
# makes that slot the one the app opens on next launch. Run from the worktree you want to ship.
#   pwsh -NoProfile -File fork/ship.ps1                       # HEAD must contain mine
#   pwsh -NoProfile -File fork/ship.ps1 -Sync <tag> -Expect <old mine>   # sync agents only
param([string]$Sync, [string]$Expect)
. "$PSScriptRoot\lib.ps1"

$here = Invoke-Git (Get-Location).Path rev-parse --show-toplevel
if (Invoke-Git $here status --porcelain --untracked-files=no) { throw 'Commit or discard your changes first.' }
$head = Invoke-Git $here rev-parse HEAD

$lock = Enter-ForkLock 30
if (-not $lock) { throw 'Another sync or ship has held the lock for 30 minutes; try again later.' }
try {
  $mine = Invoke-Git $Repo rev-parse refs/heads/mine
  $base = Invoke-Git $Repo rev-parse refs/fork/base
  if ($Sync) {
    if ($mine -ne $Expect) {
      throw "mine moved to $mine since the sync started. Pick that up with: git rebase --onto $mine $Expect, then rerun with -Expect $mine"
    }
    $newBase = Invoke-Git $Repo rev-parse "$Sync^{commit}"
    if (-not (Test-Git $Repo merge-base --is-ancestor $newBase $head)) { throw "HEAD is not on top of $Sync." }
  } else {
    if (-not (Test-Git $Repo merge-base --is-ancestor $mine $head)) { throw "HEAD doesn't contain mine ($mine). Run: git rebase mine" }
    $newBase = $base
  }

  $slot = Get-BuildSlot (Read-State)
  if (-not $slot) { throw 'Both slots are running. Quit T3 Code once, reopen it, then ship again.' }
  if (-not (Build-Slot $slot $head)) { throw "Not shipped: the build failed or was refused. See $LogDir\build-$slot.log and $LogDir\fork.log" }
  Update-Mine $head $mine $newBase $base
  Set-ActiveSlot $slot
  Write-Host "Shipped $head. T3 Code opens on it next time it starts."
} finally {
  $lock.ReleaseMutex()
  $lock.Dispose()
}
