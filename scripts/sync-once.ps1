# Single-shot sync check: if anything in the repo changed (games, testimonials,
# blog posts, uploaded images, or code edited directly), commit it and push.
# Called repeatedly (every ~10s) by sync-loop.cmd rather than running as one
# long-lived process - a long-lived PowerShell loop turned out to be prone to
# dying silently on startup on this machine, so each run here is short-lived
# and independent: if one run fails for any reason, the next one 10s later
# just tries again instead of the whole thing staying dead forever.
#
# Since editor.html can now also commit directly to GitHub on its own (from
# any device, via the GitHub API), this local checkout and the remote can
# diverge — a push here can get rejected because the remote has commits this
# checkout doesn't know about yet. This script fetches and, if the remote has
# moved ahead, merges it in before pushing, every run (not just when there
# are new local edits) - otherwise a once-rejected push would keep failing
# forever with nothing left locally to trigger a retry.

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
    if (-not [string]::IsNullOrWhiteSpace($status)) {
        Write-Log "Detected changes:`n$status"
        git add -A 2>&1 | Out-Null
        $commitMsg = "Auto-sync changes`n`nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
        $commitOutput = git commit -m $commitMsg 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "Commit failed or nothing staged: $commitOutput"
        } else {
            Write-Log "Committed: $commitOutput"
        }
    }

    git fetch origin 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit 0  # offline or GitHub unreachable this cycle - just try again next time
    }

    $localHead = git rev-parse HEAD 2>&1
    $remoteHead = git rev-parse origin/main 2>&1
    if ($localHead -eq $remoteHead) {
        exit 0  # already in sync, nothing to push
    }

    $pushOutput = git push 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Log "Pushed successfully."
        exit 0
    }

    Write-Log "Push rejected (remote has commits this checkout doesn't - e.g. from the online editor). Merging: $pushOutput"
    $mergeMsg = "Merge remote changes (auto-sync)`n`nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
    $mergeOutput = git merge origin/main -m $mergeMsg 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "MERGE FAILED - needs a manual look (likely a real conflicting edit): $mergeOutput"
        git merge --abort 2>&1 | Out-Null
        exit 0
    }
    Write-Log "Merged remote changes."

    $pushOutput2 = git push 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "PUSH FAILED even after merge: $pushOutput2"
    } else {
        Write-Log "Pushed successfully after merging remote changes."
    }
} catch {
    Write-Log "ERROR: $_"
}
