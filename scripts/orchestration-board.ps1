[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet(
    "status",
    "sync",
    "publish",
    "claim",
    "renew",
    "release",
    "dispatch-claim",
    "dispatch-result",
    "idea"
    ,"local-claim"
    ,"local-renew"
    ,"local-close"
  )]
  [string]$Action,

  [string]$Task,
  [string]$Agent,
  [string]$BodyPath,
  [ValidateSet("claimed", "review", "completed")]
  [string]$CheckpointStatus = "claimed",
  [string]$Summary,
  [string[]]$Files = @(),
  [string[]]$Tests = @(),
  [string[]]$Blockers = @(),
  [string]$Next = "",
  [int]$LeaseSeconds = 1800,
  [string]$SourceRevision,
  [string]$IdempotencyKey,
  [ValidateSet("created", "failed")]
  [string]$Outcome,
  [string]$CloudTaskId,
  [string]$CloudTaskUrl,
  [string]$FailureCode,
  [ValidateSet("worker", "orchestrator")]
  [string]$Role,
  [ValidateSet("P0", "P1", "P2", "P3")]
  [string]$IdeaPriority,
  [string]$Evidence,
  [string]$Proposal
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$gitCommonDir = (& git -C $repoRoot rev-parse --path-format=absolute --git-common-dir).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitCommonDir)) {
  throw "Unable to resolve the shared Git directory"
}
$orchestrationRoot = Join-Path (Split-Path -Parent $gitCommonDir) ".codex\orchestration"
$secretRoot = Join-Path $orchestrationRoot "secrets"

function Get-ConfiguredValue {
  param([Parameter(Mandatory)][string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, "User")
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required local configuration: $Name"
  }
  return $value
}

function Get-SafeTaskName {
  param([Parameter(Mandatory)][string]$Value)
  if ($Value -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
    throw "Invalid task ID"
  }
  return $Value -replace "[^A-Za-z0-9._-]", "_"
}

function Get-SecretPath {
  param(
    [Parameter(Mandatory)][string]$Kind,
    [Parameter(Mandatory)][string]$TaskId
  )
  $safeTask = Get-SafeTaskName $TaskId
  return Join-Path $secretRoot "$safeTask.$Kind.dpapi"
}

function Save-PrivateToken {
  param(
    [Parameter(Mandatory)][string]$Kind,
    [Parameter(Mandatory)][string]$TaskId,
    [Parameter(Mandatory)][string]$Token
  )
  if ($Token.Length -lt 32) {
    throw "Refusing to store an invalid token"
  }
  New-Item -ItemType Directory -Force -Path $secretRoot | Out-Null
  $secure = ConvertTo-SecureString $Token -AsPlainText -Force
  $encrypted = ConvertFrom-SecureString $secure
  Set-Content -LiteralPath (Get-SecretPath $Kind $TaskId) -Value $encrypted -NoNewline
}

function Read-PrivateToken {
  param(
    [Parameter(Mandatory)][string]$Kind,
    [Parameter(Mandatory)][string]$TaskId
  )
  $path = Get-SecretPath $Kind $TaskId
  if (-not (Test-Path -LiteralPath $path)) {
    throw "No local $Kind credential exists for task $TaskId"
  }
  $encrypted = Get-Content -Raw -LiteralPath $path
  $secure = ConvertTo-SecureString $encrypted
  return [System.Net.NetworkCredential]::new("", $secure).Password
}

function Require-Value {
  param(
    [Parameter(Mandatory)][string]$Name,
    [AllowEmptyString()][string]$Value
  )
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name is required for action $Action"
  }
}

function Require-BoundedText {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Value,
    [Parameter(Mandatory)][int]$MaximumLength
  )
  Require-Value $Name $Value
  if ($Value.Length -gt $MaximumLength -or $Value -match "[\r\n|]") {
    throw "$Name must be one line, pipe-free, and at most $MaximumLength characters"
  }
}

function Get-ProtocolRoute {
  param([Parameter(Mandatory)][string]$Name)
  $configPath = Join-Path $orchestrationRoot "config.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Missing orchestration config: $configPath"
  }
  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $route = $config.protocol.routes.$Name
  if ([string]::IsNullOrWhiteSpace($route)) {
    throw "Missing protocol route: $Name"
  }
  return [string]$route
}

function Resolve-BoardUri {
  param([Parameter(Mandatory)][string]$RouteName)
  $baseUrl = (Get-ConfiguredValue "GAUSSIANEDIT_ORCHESTRATION_BASE_URL").TrimEnd('/')
  $route = Get-ProtocolRoute $RouteName
  if ($route -match '^https://') {
    return $route
  }
  if ($route.StartsWith('/')) {
    $base = [Uri]$baseUrl
    return "$($base.Scheme)://$($base.Authority)$route"
  }
  return "$baseUrl/$($route.TrimStart('/'))"
}

function Export-LocalBoard {
  $dashboardPath = Join-Path $orchestrationRoot "dashboard.json"
  $metaPath = Join-Path $orchestrationRoot "meta.json"
  if ((Test-Path -LiteralPath $dashboardPath) -and (Test-Path -LiteralPath $metaPath)) {
    $dashboard = Get-Content -Raw -LiteralPath $dashboardPath | ConvertFrom-Json
    $meta = Get-Content -Raw -LiteralPath $metaPath | ConvertFrom-Json
    if ([int]$dashboard.lastSeq -eq ([int]$meta.nextSeq - 1)) {
      return
    }
  }
  $codexRoot = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path $HOME ".codex"
  } else {
    $env:CODEX_HOME
  }
  $helper = Join-Path $codexRoot "skills\orchestrate-development\scripts\orchestrate.py"
  if (-not (Test-Path -LiteralPath $helper)) {
    throw "Missing orchestrate-development helper"
  }
  & python $helper export --root $repoRoot | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Local orchestration export failed"
  }
}

function Get-OrchestrationHelper {
  $codexRoot = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path $HOME ".codex"
  } else {
    $env:CODEX_HOME
  }
  $helper = Join-Path $codexRoot "skills\orchestrate-development\scripts\orchestrate.py"
  if (-not (Test-Path -LiteralPath $helper)) {
    throw "Missing orchestrate-development helper"
  }
  return $helper
}

function Set-TaskCategories {
  param([Parameter(Mandatory)][object]$Document)

  foreach ($task in @($Document.tasks)) {
    if ($null -eq $task) { continue }
    $taskId = [string]($task.task ?? $task.taskId)
    $files = if ($task.latest -and $task.latest.files) {
      @($task.latest.files)
    } elseif ($task.files) {
      @($task.files)
    } else {
      @()
    }
    $systemFiles = $files.Count -gt 0 -and @(
      $files | Where-Object {
        [string]$_ -notmatch '^(?:\.codex/|\.agents/|\.claude/|AGENTS\.md$|AGENT_HANDOFF\.md$|ORCHESTRATION|SCHEDULED_DISPATCH_PROMPT\.md$|dashboard-site/|scripts/(?:orchestration|export-orchestration|agent-start-hook))'
      }
    ).Count -eq 0
    $systemTask = $taskId -match '^(?:agent-start|audit-|board-|candidate-feedback-|candidate-workflow-|cloud-dashboard|cloud-dispatch|connector-|orchestration-|scheduled-codex-|staging-release-|status-)'
    $category = if ($systemTask -or $systemFiles) { 'system' } else { 'product' }
    $task | Add-Member -NotePropertyName category -NotePropertyValue $category -Force
  }

  return $Document
}

function Invoke-BoardRequest {
  param(
    [Parameter(Mandatory)][ValidateSet("GET", "POST")][string]$Method,
    [Parameter(Mandatory)][string]$RouteName,
    [object]$Body
  )
  $baseUrl = (Get-ConfiguredValue "GAUSSIANEDIT_ORCHESTRATION_BASE_URL").TrimEnd('/')
  $headers = @{
    "Authorization" = "Bearer $(Get-ConfiguredValue 'GAUSSIANEDIT_ORCHESTRATION_API_TOKEN')"
    "Accept" = "application/json"
  }
  if ([Uri]$baseUrl -and ([Uri]$baseUrl).Host -eq "gaussianedit-orchestration.juhana-kaa.chatgpt.site") {
    $headers["OAI-Sites-Authorization"] = "Bearer $(Get-ConfiguredValue 'GAUSSIANEDIT_SITES_BYPASS_TOKEN')"
  }
  $arguments = @{
    Uri = Resolve-BoardUri $RouteName
    Method = $Method
    Headers = $headers
    SkipHttpErrorCheck = $true
  }
  if ($Method -eq "POST") {
    $arguments.ContentType = "application/json"
    $arguments.Body = $Body | ConvertTo-Json -Depth 20 -Compress
  }
  $response = Invoke-WebRequest @arguments
  $document = $null
  try {
    $document = $response.Content | ConvertFrom-Json
  } catch {
    throw "Board returned non-JSON HTTP $([int]$response.StatusCode)"
  }
  if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
    $code = if ($document.error) { $document.error } else { "HTTP_$([int]$response.StatusCode)" }
    throw "Board request failed: $code"
  }
  return $document
}

switch ($Action) {
  "idea" {
    Require-Value Agent $Agent
    Require-Value Role $Role
    Require-Value IdeaPriority $IdeaPriority
    Require-BoundedText Evidence $Evidence 400
    Require-BoundedText Proposal $Proposal 600
    # Ideas deliberately remain comments on the dedicated intake record. They
    # are not jobs, claims, handoffs, or dispatch authority.
    $summary = "IDEA|role=$Role|priority=$IdeaPriority|evidence=$Evidence|proposal=$Proposal"
    $arguments = @(
      (Get-OrchestrationHelper), "comment", "orchestration-improvement-intake", $Agent, $summary,
      "--root", $repoRoot,
      "--next", "Root evaluates evidence and either rejects, defers, or publishes a separate job."
    )
    & python @arguments
    if ($LASTEXITCODE -ne 0) { throw "Idea submission failed" }
  }
  "local-claim" {
    Require-Value Task $Task
    Require-Value Agent $Agent
    $raw = & python (Get-OrchestrationHelper) claim $Task $Agent --root $repoRoot | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Local work claim failed" }
    $result = $raw | ConvertFrom-Json
    Save-PrivateToken "lease" $Task $result.lease.token
    $result.lease.PSObject.Properties.Remove("token")
    if ($result.job.lease) { $result.job.lease.PSObject.Properties.Remove("token") }
    $result | ConvertTo-Json -Depth 20
  }
  "local-renew" {
    Require-Value Task $Task
    Require-Value Agent $Agent
    Require-Value Summary $Summary
    $arguments = @(
      (Get-OrchestrationHelper), "update", $Task, $Agent, "in_progress", $Summary,
      "--root", $repoRoot,
      "--event", "checkpoint",
      "--lease-token", (Read-PrivateToken "lease" $Task),
      "--tests", ($Tests -join ","),
      "--blockers", ($Blockers -join ","),
      "--next", $Next,
      "--files", ($Files -join ",")
    )
    & python @arguments
    if ($LASTEXITCODE -ne 0) { throw "Local work lease renewal failed" }
  }
  "local-close" {
    Require-Value Task $Task
    Require-Value Agent $Agent
    Require-Value Summary $Summary
    $arguments = @(
      (Get-OrchestrationHelper), "close", $Task, $Agent, $Summary,
      "--root", $repoRoot,
      "--lease-token", (Read-PrivateToken "lease" $Task),
      "--tests", ($Tests -join ","),
      "--blockers", ($Blockers -join ","),
      "--next", $Next,
      "--files", ($Files -join ",")
    )
    & python @arguments
    if ($LASTEXITCODE -ne 0) { throw "Local work close failed" }
  }
  "status" {
    $result = Invoke-BoardRequest GET "status"
    $result | ConvertTo-Json -Depth 20
  }
  "sync" {
    $syncPath = if ([string]::IsNullOrWhiteSpace($BodyPath)) {
      Export-LocalBoard
      Join-Path $orchestrationRoot "dashboard.json"
    } else {
      $BodyPath
    }
    $resolvedBody = Resolve-Path -LiteralPath $syncPath
    $body = Get-Content -Raw -LiteralPath $resolvedBody | ConvertFrom-Json
    # Product means work on the GaussianEdit 3D editor. Board, connector,
    # orchestration, agent, audit, dispatch, release, and workflow plumbing are
    # system work even when they coordinate or validate product changes.
    $body = Set-TaskCategories $body
    $result = Invoke-BoardRequest POST "sync" $body
    $result | ConvertTo-Json -Depth 20
  }
  "publish" {
    Require-Value BodyPath $BodyPath
    $resolvedBody = Resolve-Path -LiteralPath $BodyPath
    $body = Get-Content -Raw -LiteralPath $resolvedBody | ConvertFrom-Json
    $result = Invoke-BoardRequest POST "publishJob" $body
    Save-PrivateToken "release" $result.task $result.releaseToken
    $result.PSObject.Properties.Remove("releaseToken")
    $result | ConvertTo-Json -Depth 20
  }
  "claim" {
    Require-Value Task $Task
    Require-Value Agent $Agent
    $result = Invoke-BoardRequest POST "claimWork" @{
      task = $Task
      agent = $Agent
      leaseSeconds = $LeaseSeconds
    }
    Save-PrivateToken "lease" $Task $result.lease.token
    $result.lease.PSObject.Properties.Remove("token")
    $result | ConvertTo-Json -Depth 20
  }
  "renew" {
    Require-Value Task $Task
    Require-Value Agent $Agent
    Require-Value Summary $Summary
    $token = Read-PrivateToken "lease" $Task
    $result = Invoke-BoardRequest POST "renewWork" @{
      task = $Task
      agent = $Agent
      token = $token
      leaseSeconds = $LeaseSeconds
      checkpoint = @{
        status = $CheckpointStatus
        summary = $Summary
        tests = @($Tests)
        blockers = @($Blockers)
        next = $Next
      }
    }
    if ($result.lease -and $result.lease.token) {
      Save-PrivateToken "lease" $Task $result.lease.token
      $result.lease.PSObject.Properties.Remove("token")
    }
    $result | ConvertTo-Json -Depth 20
  }
  "release" {
    Require-Value Task $Task
    Require-Value Summary $Summary
    $releaseToken = Read-PrivateToken "release" $Task
    $result = Invoke-BoardRequest POST "releaseWork" @{
      task = $Task
      releaseToken = $releaseToken
      reason = $Summary
      orphan = $true
    }
    $result | ConvertTo-Json -Depth 20
  }
  "dispatch-claim" {
    Require-Value Task $Task
    Require-Value SourceRevision $SourceRevision
    Require-Value IdempotencyKey $IdempotencyKey
    $result = Invoke-BoardRequest POST "claim" @{
      taskId = $Task
      sourceRevision = $SourceRevision
      idempotencyKey = $IdempotencyKey
      leaseSeconds = $LeaseSeconds
    }
    Save-PrivateToken "dispatch" $Task $result.leaseToken
    $result.PSObject.Properties.Remove("leaseToken")
    $result | ConvertTo-Json -Depth 20
  }
  "dispatch-result" {
    Require-Value Task $Task
    Require-Value SourceRevision $SourceRevision
    Require-Value IdempotencyKey $IdempotencyKey
    Require-Value Outcome $Outcome
    $body = @{
      taskId = $Task
      sourceRevision = $SourceRevision
      idempotencyKey = $IdempotencyKey
      leaseToken = Read-PrivateToken "dispatch" $Task
      outcome = $Outcome
    }
    if ($Outcome -eq "created") {
      Require-Value CloudTaskId $CloudTaskId
      Require-Value CloudTaskUrl $CloudTaskUrl
      $body.cloudTaskId = $CloudTaskId
      $body.cloudTaskUrl = $CloudTaskUrl
    } else {
      Require-Value FailureCode $FailureCode
      $body.failureCode = $FailureCode
    }
    $result = Invoke-BoardRequest POST "dispatchResult" $body
    $result | ConvertTo-Json -Depth 20
  }
}
