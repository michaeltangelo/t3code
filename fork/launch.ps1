# What the taskbar shortcut runs (from the bin copy): open the last good build, then sync in the
# background. Opening never waits on git, the network or a build.
. "$PSScriptRoot\lib.ps1"

try { $slot = Get-LaunchSlot (Read-State) } catch { $slot = 'a' }
$desktop = Join-Path $Root "$slot\apps\desktop"
Start-Process (Join-Path $desktop 'node_modules\electron\dist\electron.exe') 'dist-electron\main.cjs' -WorkingDirectory $desktop

Start-Process pwsh -WindowStyle Hidden -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-File', (Join-Path $PSScriptRoot 'sync.ps1'))
