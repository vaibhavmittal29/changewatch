$ErrorActionPreference = "Stop"

Write-Host "--- Independent Registration Endpoint Test ---" -ForegroundColor Cyan
$baseUrl = "http://127.0.0.1:3000"
$unique = [System.Guid]::NewGuid().ToString().Substring(0, 8)
$body = @{
    email = "single_test_$unique@example.com"
    password = "TestPassword123!"
    displayName = "Single Test $unique"
} | ConvertTo-Json

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
    Write-Host "Sending POST $baseUrl/api/auth/register..."
    $response = Invoke-WebRequest -Uri "$baseUrl/api/auth/register" -Method Post -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 10
    $stopwatch.Stop()
    Write-Host "Response received in $($stopwatch.ElapsedMilliseconds)ms, Status: $($response.StatusCode)" -ForegroundColor Green
    Write-Host "Body: $($response.Content)"
} catch [System.Net.WebException] {
    $stopwatch.Stop()
    Write-Host "Request failed in $($stopwatch.ElapsedMilliseconds)ms: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host "Error Body: $($reader.ReadToEnd())" -ForegroundColor Red
    }
    exit 1
} catch {
    $stopwatch.Stop()
    Write-Host "Unexpected error in $($stopwatch.ElapsedMilliseconds)ms: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
