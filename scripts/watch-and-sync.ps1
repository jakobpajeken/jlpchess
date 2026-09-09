# Watches data\ and images\ for changes made by editor.html (which writes
# directly to disk via the browser's File System Access API, bypassing git
# entirely) and automatically commits + pushes them to GitHub.
#
# Uses simple polling (git status every few seconds) rather than a
# FileSystemWatcher - much more reliable in practice than PowerShell's
# event-queue subsystem for this kind of background loop.
#
# Runs continuously. Starts automatically at login via a shortcut in the
# Startup folder (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup).

$repoRoot = "C:\Users\ullap\Documents\Arbeit\Schach\Website"
$logFile = Join-Path $repoRoot "scripts\sync.log"
$watchPaths = @("data", "images")
$pollSeconds = 10

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$timestamp] $Message"
}

function Sync-Changes {
    Set-Location $repoRoot
    # git add fails ENTIRELY (stages nothing) if any pathspec matches zero
    # files - e.g. "images" doesn't exist yet until the editor uploads its
    # first photo - so only pass in the paths that currently exist.
    $existingPaths = $watchPaths | Where-Object { Test-Path (Join-Path $repoRoot $_) }
    if ($existingPaths.Count -eq 0) { return }
    $status = git status --porcelain -- $existingPaths 2>&1
    if ([string]::IsNullOrWhiteSpace($status)) {
        return
    }
    Write-Log "Detected changes:`n$status"
    git add -A -- $existingPaths 2>&1 | Out-Null
    $commitMsg = "Auto-sync content via editor`n`nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
    $commitOutput = git commit -m $commitMsg 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Commit failed or nothing to commit: $commitOutput"
        return
    }
    Write-Log "Committed: $commitOutput"
    $pushOutput = git push 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "PUSH FAILED: $pushOutput"
    } else {
        Write-Log "Pushed successfully."
    }
}

Write-Log "Watcher starting up (polling every $pollSeconds s)."

while ($true) {
    try { Sync-Changes } catch { Write-Log "ERROR: $_" }
    Start-Sleep -Seconds $pollSeconds
}
