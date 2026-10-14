$ErrorActionPreference = "Stop"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " ChangeWatch Phase 1 Verification Script" -ForegroundColor Cyan
Write-Host " Testing: Health -> Register -> Login -> Create -> List" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

# Use 127.0.0.1 to avoid Windows IPv6 / proxy auto-detect latency
$baseUrl = "http://127.0.0.1:3000"
$evidencePath = "docs/evidence/phase-1/api-flow.txt"
$evidenceDir = Split-Path $evidencePath
if (-not (Test-Path $evidenceDir)) {
    New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
}

$logOutput = @()
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Log-Message($msg, $color = "White") {
    $timestamp = (Get-Date -Format 'o')
    $formatted = "[$timestamp] $msg"
    Write-Host $formatted -ForegroundColor $color
    $script:logOutput += $formatted
}

function Invoke-LoggedRequest {
    param (
        [string]$Name,
        [string]$Method,
        [string]$Endpoint,
        [hashtable]$Headers = @{},
        [object]$Body = $null,
        [int]$TimeoutSeconds = 10
    )

    $url = "$baseUrl$Endpoint"
    Log-Message ">>> [START $Name] $Method $url" "Cyan"
    
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $jsonBody = $null
    if ($null -ne $Body) {
        $jsonBody = $Body | ConvertTo-Json -Depth 5 -Compress
        Log-Message "    Payload: $jsonBody" "DarkGray"
    }

    try {
        $params = @{
            Uri = $url
            Method = $Method
            UseBasicParsing = $true
            TimeoutSec = $TimeoutSeconds
            WebSession = $script:session
            Headers = $Headers
        }
        if ($jsonBody) {
            $params["Body"] = $jsonBody
            $params["ContentType"] = "application/json"
        }

        $response = Invoke-WebRequest @params
        $stopwatch.Stop()
        $elapsed = $stopwatch.ElapsedMilliseconds

        Log-Message "<<< [PASS $Name] Status: $($response.StatusCode) (${elapsed}ms)" "Green"
        
        $content = $response.Content
        if ($content) {
            $parsed = $content | ConvertFrom-Json
            return $parsed
        }
        return $null
    }
    catch [System.Net.WebException] {
        $stopwatch.Stop()
        $elapsed = $stopwatch.ElapsedMilliseconds
        $ex = $_.Exception
        $statusCode = "NO_RESPONSE"
        $responseBody = ""

        if ($ex.Response) {
            $statusCode = [int]$ex.Response.StatusCode
            $reader = New-Object System.IO.StreamReader($ex.Response.GetResponseStream())
            $responseBody = $reader.ReadToEnd()
        }

        Log-Message "!!! [FAIL $Name] Status: $statusCode (${elapsed}ms) Error: $($ex.Message)" "Red"
        if ($responseBody) {
            Log-Message "    Response Body: $responseBody" "Red"
        }
        
        # Save log before exiting
        $script:logOutput | Out-File -FilePath $evidencePath -Encoding utf8
        throw "Verification step failed: $Name ($($ex.Message))"
    }
    catch {
        $stopwatch.Stop()
        $elapsed = $stopwatch.ElapsedMilliseconds
        Log-Message "!!! [ERROR $Name] Failed after ${elapsed}ms: $($_.Exception.Message)" "Red"
        $script:logOutput | Out-File -FilePath $evidencePath -Encoding utf8
        throw $_
    }
}

try {
    # Step 0: Health check
    Log-Message "STEP 0: Checking Server Health..." "Yellow"
    $health = Invoke-LoggedRequest -Name "HealthCheck" -Method "GET" -Endpoint "/api/health"
    Log-Message "Server is healthy. Timestamp: $($health.timestamp)" "Green"

    # Step 1: Register unique test user
    $uniqueId = [System.Guid]::NewGuid().ToString().Substring(0, 8)
    $testEmail = "verifier_$uniqueId@changewatch.local"
    $testPassword = "StrongPassword123!"
    $testName = "Verifier $uniqueId"

    Log-Message "STEP 1: Registering Test User ($testEmail)..." "Yellow"
    $regData = Invoke-LoggedRequest -Name "Register" -Method "POST" -Endpoint "/api/auth/register" -Body @{
        email = $testEmail
        password = $testPassword
        displayName = $testName
    }
    $csrfToken = $regData.csrfToken
    $userId = $regData.user.id
    Log-Message "User registered successfully: ID=$userId, CSRF=$csrfToken" "Green"

    # Step 2: Login
    Log-Message "STEP 2: Logging in as Test User..." "Yellow"
    $loginData = Invoke-LoggedRequest -Name "Login" -Method "POST" -Endpoint "/api/auth/login" -Body @{
        email = $testEmail
        password = $testPassword
    }
    # Update CSRF token from login response
    $csrfToken = $loginData.csrfToken
    Log-Message "Login successful: DisplayName=$($loginData.user.displayName)" "Green"

    # Step 3: Verify /api/auth/me session
    Log-Message "STEP 3: Verifying active session via /api/auth/me..." "Yellow"
    $meData = Invoke-LoggedRequest -Name "GetMe" -Method "GET" -Endpoint "/api/auth/me"
    if ($meData.user.id -ne $userId) {
        throw "Session mismatch: expected $userId, got $($meData.user.id)"
    }
    Log-Message "Session verified for user: $($meData.user.email)" "Green"

    # Step 4: Create a subscription
    Log-Message "STEP 4: Creating Subscription with CSRF Token..." "Yellow"
    $subData = Invoke-LoggedRequest -Name "CreateSubscription" -Method "POST" -Endpoint "/api/subscriptions" -Headers @{
        "X-CSRF-Token" = $csrfToken
    } -Body @{
        url = "https://example.com/pricing"
        name = "Pricing Monitor $uniqueId"
        interval_minutes = 30
        sensitivity = "balanced"
    }
    $subId = $subData.id
    Log-Message "Subscription created: ID=$subId, Fingerprint=$($subData.capture_fingerprint)" "Green"

    # Step 5: List subscriptions and verify ownership
    Log-Message "STEP 5: Listing Subscriptions (Ownership Isolation Check)..." "Yellow"
    $listData = Invoke-LoggedRequest -Name "ListSubscriptions" -Method "GET" -Endpoint "/api/subscriptions"
    $matchingSub = $listData.subscriptions | Where-Object { $_.id -eq $subId }
    if (-not $matchingSub) {
        throw "Created subscription $subId not found in user subscription list!"
    }
    Log-Message "Verified subscription presence: Name='$($matchingSub.name)', CanonicalUrl='$($matchingSub.canonical_url)'" "Green"

    # Verification summary
    Write-Host "`n=================================================" -ForegroundColor Green
    Write-Host " ALL PHASE 1 VERIFICATION CHECKS PASSED!" -ForegroundColor Green
    Write-Host " Evidence saved to: $evidencePath" -ForegroundColor Green
    Write-Host "=================================================`n" -ForegroundColor Green

    $script:logOutput += "[$(Get-Date -Format 'o')] ALL PHASE 1 CHECKS PASSED"
    $script:logOutput | Out-File -FilePath $evidencePath -Encoding utf8
}
catch {
    Write-Host "`nVerification terminated with error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
