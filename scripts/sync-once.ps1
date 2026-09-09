# Single-shot sync check: if anything in the repo changed (games, testimonials,
# blog posts, uploaded images, or code edited directly), commit it and push.
# Called repeatedly (every ~10s) by sync-loop.cmd rather than running as one
# long-lived process - a long-lived PowerShell loop turned out to be prone to
# dying silently on startup on this machine, so each run here is short-lived
# and independent: if one run fails for any reason, the next one 10s later
# just tries again instead of the whole thing staying dead forever.

$repoRoot = "C:\Users\ullap\Documents\Arbeit\Schach\Website"
$logFile = Join-Path $repoRoot "scripts\sync.log"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$timestamp] $Message"
}

try {
    Set-Location $repoRoot

    $status = git status --porcelain 2>&1
    if ([string]::IsNullOrWhiteSpace($status)) {
        exit 0
    }

    Write-Log "Detected changes:`n$status"
    git add -A 2>&1 | Out-Null
    $commitMsg = "Auto-sync changes`n`nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
    $commitOutput = git commit -m $commitMsg 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Commit failed or nothing staged: $commitOutput"
        exit 0
    }
    Write-Log "Committed: $commitOutput"

    $pushOutput = git push 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "PUSH FAILED: $pushOutput"
    } else {
        Write-Log "Pushed successfully."
    }
} catch {
    Write-Log "ERROR: $_"
}
