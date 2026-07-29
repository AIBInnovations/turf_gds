param(
  [string]$BaseUrl = "http://127.0.0.1:3317",
  [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"
$script:Results = [System.Collections.Generic.List[object]]::new()
$script:CaseNumber = 0
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("turf-gds-curl-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$responseFile = Join-Path $tempRoot "response.json"
$requestFile = Join-Path $tempRoot "request.json"
$mediaFile = Join-Path $tempRoot "fixture.png"
[System.IO.File]::WriteAllBytes($mediaFile, [byte[]](137,80,78,71,13,10,26,10,1,2,3,4))

function Redact([string]$Text) {
  if (-not $Text) { return "" }
  $value = $Text
  foreach ($field in @("sessionToken", "accessToken", "apiKey", "signingSecret", "vaultAccountToken")) {
    $value = [regex]::Replace(
      $value,
      "(?i)(`"$field`"\s*:\s*`")[^`"]+(`")",
      '$1[REDACTED]$2'
    )
  }
  if ($value.Length -gt 240) { return $value.Substring(0, 240) + "..." }
  return $value
}

function Invoke-CurlCase {
  param(
    [string]$Module,
    [string]$Name,
    [string]$Method,
    [string]$Path,
    [int[]]$Expected,
    [string]$Body = "",
    [hashtable]$Headers = @{},
    [string]$FormFile = ""
  )
  $script:CaseNumber++
  $arguments = @("-sS", "-o", $responseFile, "-w", "%{http_code}", "-X", $Method)
  foreach ($entry in $Headers.GetEnumerator()) {
    $arguments += @("-H", "$($entry.Key): $($entry.Value)")
  }
  if ($FormFile) {
    $arguments += @("-F", "file=@$FormFile;type=image/png")
  } elseif ($Body) {
    [System.IO.File]::WriteAllText(
      $requestFile,
      $Body,
      [System.Text.UTF8Encoding]::new($false)
    )
    $arguments += @(
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@$requestFile"
    )
  }
  $arguments += "$BaseUrl$Path"
  $statusText = & curl.exe @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed for $Method $Path with exit code $LASTEXITCODE"
  }
  $status = [int]$statusText
  $response = if (Test-Path $responseFile) {
    [System.IO.File]::ReadAllText($responseFile)
  } else { "" }
  $passed = $Expected -contains $status
  $script:Results.Add([pscustomobject]@{
    Number = $script:CaseNumber
    Module = $Module
    Case = $Name
    Method = $Method
    Path = $Path
    Expected = ($Expected -join "/")
    Actual = $status
    Passed = $passed
    Evidence = (Redact $response)
  })
  if (-not $passed) {
    throw "Case '$Name' expected $($Expected -join '/') but got $status. Body: $(Redact $response)"
  }
  if (-not $response) { return $null }
  try { return $response | ConvertFrom-Json } catch { return $response }
}

function Add-SemanticCheck {
  param([string]$Module, [string]$Name, [bool]$Passed, [string]$Evidence)
  $script:CaseNumber++
  $script:Results.Add([pscustomobject]@{
    Number = $script:CaseNumber
    Module = $Module
    Case = $Name
    Method = "ASSERT"
    Path = "-"
    Expected = "true"
    Actual = if ($Passed) { "true" } else { "false" }
    Passed = $Passed
    Evidence = (Redact $Evidence)
  })
  if (-not $Passed) { throw "Semantic check failed: $Name ($Evidence)" }
}

function Json($Value) {
  return ($Value | ConvertTo-Json -Compress -Depth 12)
}

function Bearer([string]$Token) {
  return @{ Authorization = "Bearer $Token" }
}

function New-PartnerHeaders {
  param(
    [string]$ApiKey,
    [string]$SigningSecret,
    [string]$Method,
    [string]$Path,
    [string]$Body,
    [long]$Timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  )
  $utf8 = [System.Text.Encoding]::UTF8
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bodyHash = (
      [System.BitConverter]::ToString(
        $sha.ComputeHash($utf8.GetBytes($Body))
      ) -replace "-",
      ""
    ).ToLowerInvariant()
  } finally { $sha.Dispose() }
  $canonical = "$Timestamp`n$($Method.ToUpperInvariant())`n$Path`n$bodyHash"
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($utf8.GetBytes($SigningSecret))
  try {
    $signature = (
      [System.BitConverter]::ToString(
        $hmac.ComputeHash($utf8.GetBytes($canonical))
      ) -replace "-",
      ""
    ).ToLowerInvariant()
  } finally { $hmac.Dispose() }
  return @{
    "x-api-key" = $ApiKey
    "x-signature" = "sha256=$signature"
    "x-timestamp" = "$Timestamp"
  }
}

try {
  $runId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $phoneBase = [long]6000000000 + ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() % [long]3000000000)
  Invoke-CurlCase "Platform" "Health endpoint" "GET" "/health" @(200) | Out-Null
  Invoke-CurlCase "Platform" "Dependency readiness" "GET" "/ready" @(200) | Out-Null
  Invoke-CurlCase "Platform" "API version discovery" "GET" "/api/v1" @(200) | Out-Null
  $unknown = Invoke-CurlCase "Platform" "Unknown route error envelope" "GET" "/api/v1/not-a-route" @(404)
  Add-SemanticCheck "Platform" "Unknown route has stable error code" ($unknown.error.code -eq "ROUTE_NOT_FOUND") (Json $unknown)

  $ownerOneRegistration = @{
    legalName = "Curl Owner One Private Limited"
    email = "curl-owner-one-$runId@example.com"
    phoneE164 = "+91$phoneBase"
    password = "OwnerPassword123!"
    venue = @{
      legalName = "Curl Arena One Private Limited"
      displayName = "Curl Arena One"
      timezone = "Asia/Kolkata"
      address = @{
        line1 = "1 Test Road"; city = "Bengaluru"; state = "Karnataka"
        postalCode = "560001"; country = "IN"
      }
      latitude = 12.9716; longitude = 77.5946
    }
  }
  $ownerTwoRegistration = @{
    legalName = "Curl Owner Two Private Limited"
    email = "curl-owner-two-$runId@example.com"
    phoneE164 = "+91$($phoneBase + 1)"
    password = "OwnerPassword123!"
    venue = @{
      legalName = "Curl Arena Two Private Limited"
      displayName = "Curl Arena Two"
      timezone = "Asia/Kolkata"
      address = @{
        line1 = "2 Test Road"; city = "Bengaluru"; state = "Karnataka"
        postalCode = "560002"; country = "IN"
      }
      latitude = 12.9720; longitude = 77.5950
    }
  }
  Invoke-CurlCase "Owner Identity" "Reject malformed registration" "POST" "/api/v1/auth/venue-owners/register" @(400) (Json @{
    legalName = "X"; email = "bad"; phoneE164 = "123"; password = "short"; venue = @{}
  }) | Out-Null
  $ownerOne = Invoke-CurlCase "Owner Identity" "Register first Venue Owner aggregate" "POST" "/api/v1/auth/venue-owners/register" @(201) (Json $ownerOneRegistration)
  $ownerTwo = Invoke-CurlCase "Owner Identity" "Register second isolated Venue Owner" "POST" "/api/v1/auth/venue-owners/register" @(201) (Json $ownerTwoRegistration)
  Invoke-CurlCase "Owner Identity" "Reject duplicate owner registration" "POST" "/api/v1/auth/venue-owners/register" @(409) (Json $ownerOneRegistration) | Out-Null
  Invoke-CurlCase "Owner Identity" "Reject invalid owner credentials" "POST" "/api/v1/auth/venue-owners/login" @(401) (Json @{
    email = $ownerOneRegistration.email; password = "WrongPassword123!"
  }) | Out-Null
  $ownerOneLogin = Invoke-CurlCase "Owner Identity" "Login first Venue Owner" "POST" "/api/v1/auth/venue-owners/login" @(200) (Json @{
    email = $ownerOneRegistration.email; password = $ownerOneRegistration.password
  })
  $ownerTwoLogin = Invoke-CurlCase "Owner Identity" "Login second Venue Owner" "POST" "/api/v1/auth/venue-owners/login" @(200) (Json @{
    email = $ownerTwoRegistration.email; password = $ownerTwoRegistration.password
  })
  $ownerOneHeaders = Bearer $ownerOneLogin.sessionToken
  $ownerTwoHeaders = Bearer $ownerTwoLogin.sessionToken
  Invoke-CurlCase "Owner Identity" "Reject missing owner session" "GET" "/api/v1/auth/venue-owners/me" @(401) | Out-Null
  $ownerProfile = Invoke-CurlCase "Owner Identity" "Read authenticated owner profile" "GET" "/api/v1/auth/venue-owners/me" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Owner Identity" "Owner profile contains canonical membership" ($ownerProfile.memberships[0].venueId -eq $ownerOne.venueId) (Json $ownerProfile)

  $adminBad = Json @{ email = "curl-admin@example.com"; password = "WrongAdminPassword!" }
  Invoke-CurlCase "Admin Identity" "Reject invalid Admin credentials" "POST" "/api/v1/auth/admin/login" @(401) $adminBad | Out-Null
  $adminLogin = Invoke-CurlCase "Admin Identity" "Login Admin" "POST" "/api/v1/auth/admin/login" @(200) (Json @{
    email = "curl-admin@example.com"; password = "CurlAdminPassword123!"
  })
  $adminHeaders = Bearer $adminLogin.accessToken
  Invoke-CurlCase "Admin Identity" "Reject invalid Admin token" "GET" "/api/v1/auth/admin/me" @(401) "" @{ Authorization = "Bearer invalid" } | Out-Null
  Invoke-CurlCase "Admin Identity" "Read Admin identity" "GET" "/api/v1/auth/admin/me" @(200) "" $adminHeaders | Out-Null

  Invoke-CurlCase "KYC" "Reject owner KYC without authentication" "POST" "/api/v1/kyc/owner/verifications" @(401) (Json @{ verificationType = "BUSINESS" }) | Out-Null
  $businessKyc = Invoke-CurlCase "KYC" "Create BUSINESS KYC draft" "POST" "/api/v1/kyc/owner/verifications" @(201) (Json @{
    verificationType = "BUSINESS"
  }) $ownerOneHeaders
  Invoke-CurlCase "KYC" "KYC draft creation is idempotent" "POST" "/api/v1/kyc/owner/verifications" @(201) (Json @{
    verificationType = "BUSINESS"
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "KYC" "Reject KYC submission without document" "POST" "/api/v1/kyc/owner/verifications/$($businessKyc.id)/submit" @(409) "" $ownerOneHeaders | Out-Null
  Invoke-CurlCase "KYC" "Upload protected KYC document" "POST" "/api/v1/kyc/owner/verifications/$($businessKyc.id)/documents?documentType=GST_CERTIFICATE" @(201) "" $ownerOneHeaders $mediaFile | Out-Null
  Invoke-CurlCase "KYC" "Prevent cross-owner KYC document access" "POST" "/api/v1/kyc/owner/verifications/$($businessKyc.id)/documents?documentType=PAN" @(409) "" $ownerTwoHeaders $mediaFile | Out-Null
  Invoke-CurlCase "KYC" "Submit completed KYC" "POST" "/api/v1/kyc/owner/verifications/$($businessKyc.id)/submit" @(204) "" $ownerOneHeaders | Out-Null
  $currentKyc = Invoke-CurlCase "KYC" "Read current owner KYC" "GET" "/api/v1/kyc/owner/verifications/current/BUSINESS" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "KYC" "Submitted KYC is pending review" ($currentKyc.status -eq "PENDING") (Json $currentKyc)
  Invoke-CurlCase "KYC" "Reject KYC review without Admin session" "PATCH" "/api/v1/kyc/admin/verifications/$($businessKyc.id)/review" @(401) (Json @{ status = "VERIFIED" }) | Out-Null
  Invoke-CurlCase "KYC" "Admin verifies owner BUSINESS KYC" "PATCH" "/api/v1/kyc/admin/verifications/$($businessKyc.id)/review" @(204) (Json @{
    status = "VERIFIED"; expiresAt = "2028-07-28T00:00:00.000Z"
  }) $adminHeaders | Out-Null

  Invoke-CurlCase "Admin Onboarding" "Block Venue approval without verified KYC" "POST" "/api/v1/admin/onboarding/venues/$($ownerTwo.venueId)/approve" @(409) (Json @{
    ownerId = $ownerTwo.ownerId
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Admin Onboarding" "Approve verified Venue and Owner atomically" "POST" "/api/v1/admin/onboarding/venues/$($ownerOne.venueId)/approve" @(204) (Json @{
    ownerId = $ownerOne.ownerId
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Admin Onboarding" "Reject repeated Venue approval transition" "POST" "/api/v1/admin/onboarding/venues/$($ownerOne.venueId)/approve" @(409) (Json @{
    ownerId = $ownerOne.ownerId
  }) $adminHeaders | Out-Null

  Invoke-CurlCase "Owner Access" "Prevent cross-Venue profile read" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)" @(403) "" $ownerTwoHeaders | Out-Null
  Invoke-CurlCase "Owner Access" "Add Venue manager membership" "POST" "/api/v1/auth/venue-owners/venues/$($ownerOne.venueId)/members" @(201) (Json @{
    memberOwnerId = $ownerTwo.ownerId; role = "MANAGER"
  }) $ownerOneHeaders | Out-Null
  $members = Invoke-CurlCase "Owner Access" "List Venue members" "GET" "/api/v1/auth/venue-owners/venues/$($ownerOne.venueId)/members" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Owner Access" "Membership list includes owner and manager" ($members.Count -eq 2) (Json $members)
  Invoke-CurlCase "Owner Access" "Canonical OWNER membership cannot be overwritten" "POST" "/api/v1/auth/venue-owners/venues/$($ownerOne.venueId)/members" @(409) (Json @{
    memberOwnerId = $ownerOne.ownerId; role = "STAFF"
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Owner Access" "Revoke manager membership" "DELETE" "/api/v1/auth/venue-owners/venues/$($ownerOne.venueId)/members/$($ownerTwo.ownerId)" @(204) "" $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Owner Access" "Revoked manager loses Venue access" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)" @(403) "" $ownerTwoHeaders | Out-Null

  $venue = Invoke-CurlCase "Venue Profile" "Read owner-scoped Venue profile" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)" @(200) "" $ownerOneHeaders
  Invoke-CurlCase "Venue Profile" "Reject unsupported Venue currency" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)" @(400) (Json @{
    version = $venue.version; currency = "USD"
  }) $ownerOneHeaders | Out-Null
  $venueUpdated = Invoke-CurlCase "Venue Profile" "Update Venue with optimistic version" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)" @(200) (Json @{
    version = $venue.version; displayName = "Curl Arena One Updated"
  }) $ownerOneHeaders
  Invoke-CurlCase "Venue Profile" "Reject stale Venue version" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)" @(409) (Json @{
    version = $venue.version; displayName = "Stale Venue"
  }) $ownerOneHeaders | Out-Null
  $venueWithMedia = Invoke-CurlCase "Venue Profile" "Upload Venue media metadata" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/media?version=$($venueUpdated.version)" @(201) "" $ownerOneHeaders $mediaFile
  Add-SemanticCheck "Venue Profile" "Venue media increments aggregate version" ($venueWithMedia.version -eq ($venueUpdated.version + 1)) (Json $venueWithMedia)

  $court = Invoke-CurlCase "Courts" "Create Court" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts" @(201) (Json @{
    name = "Curl Court"; sportType = "FOOTBALL"; surfaceType = "ARTIFICIAL_TURF"; capacity = 14
    bookingMode = "BOTH"; minBookingMinutes = 60; bookingIncrementMinutes = 30
    fixedSlotDurationMinutes = 60; fixedSlotAnchorMinutes = 360
  }) $ownerOneHeaders
  Invoke-CurlCase "Courts" "Reject duplicate Court name" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts" @(409) (Json @{
    name = "curl court"; sportType = "CRICKET"; surfaceType = "ARTIFICIAL_TURF"; capacity = 14
    bookingMode = "FIXED_SLOT"; minBookingMinutes = 60; bookingIncrementMinutes = 30
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Courts" "Reject invalid Court duration" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts" @(400) (Json @{
    name = "Bad Duration"; sportType = "FOOTBALL"; surfaceType = "ARTIFICIAL_TURF"; capacity = 14
    bookingMode = "OPEN_TIME"; minBookingMinutes = 75; bookingIncrementMinutes = 30
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Courts" "Prevent cross-owner Court detail access" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)" @(403) "" $ownerTwoHeaders | Out-Null
  Invoke-CurlCase "Courts" "Reject invalid booking mode at route boundary" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)" @(400) (Json @{
    version = 1; bookingMode = "BOOKED"
  }) $ownerOneHeaders | Out-Null
  $courtHours = Invoke-CurlCase "Courts" "Configure Court operating hours" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/operating-hours" @(200) (Json @{
    version = 1
    operatingHours = @(@{ dayOfWeek = 4; opensAt = "06:00"; closesAt = "08:00" })
  }) $ownerOneHeaders
  Invoke-CurlCase "Courts" "Reject reversed operating hours" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/operating-hours" @(400) (Json @{
    version = $courtHours.version
    operatingHours = @(@{ dayOfWeek = 4; opensAt = "20:00"; closesAt = "08:00" })
  }) $ownerOneHeaders | Out-Null
  $courtMedia = Invoke-CurlCase "Courts" "Upload Court media metadata" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/media?version=$($courtHours.version)" @(201) "" $ownerOneHeaders $mediaFile
  Add-SemanticCheck "Courts" "Court media increments aggregate version" ($courtMedia.version -eq ($courtHours.version + 1)) (Json $courtMedia)

  Invoke-CurlCase "Venue Inventory" "Reject negative pricing" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules" @(400) (Json @{
    name = "Invalid"; dayOfWeek = 4; startTime = "06:00"; endTime = "08:00"
    priceMinor = -1; currency = "INR"; effectiveFrom = "2026-01-01T00:00:00.000Z"; priority = 1
  }) $ownerOneHeaders | Out-Null
  $price = Invoke-CurlCase "Venue Inventory" "Create pricing rule" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules" @(201) (Json @{
    name = "Weekday"; dayOfWeek = 4; startTime = "06:00"; endTime = "08:00"
    priceMinor = 125000; currency = "INR"; effectiveFrom = "2026-01-01T00:00:00.000Z"; priority = 10
  }) $ownerOneHeaders
  $prices = Invoke-CurlCase "Venue Inventory" "List Court pricing rules" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Venue Inventory" "Pricing list preserves INR amount" (($prices[0].currency -eq "INR") -and ($prices[0].priceMinor -eq 125000)) (Json $prices)
  Invoke-CurlCase "Venue Inventory" "Deactivate pricing rule" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules/$($price.id)" @(200) (Json @{
    active = $false
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Inventory" "Inactive pricing generates no slots" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/slots/generate" @(200) (Json @{
    dateFrom = "2026-07-30"; dateTo = "2026-07-30"
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Inventory" "Reactivate pricing rule" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules/$($price.id)" @(200) (Json @{
    active = $true
  }) $ownerOneHeaders | Out-Null
  $generated = Invoke-CurlCase "Venue Inventory" "Generate rolling fixed slots" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/slots/generate" @(200) (Json @{
    dateFrom = "2026-07-30"; dateTo = "2026-07-30"
  }) $ownerOneHeaders
  Add-SemanticCheck "Venue Inventory" "Two one-hour slots generated" ($generated.created -eq 2) (Json $generated)
  $generatedAgain = Invoke-CurlCase "Venue Inventory" "Slot generation is idempotent" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/slots/generate" @(200) (Json @{
    dateFrom = "2026-07-30"; dateTo = "2026-07-30"
  }) $ownerOneHeaders
  Add-SemanticCheck "Venue Inventory" "Repeated generation creates zero duplicates" ($generatedAgain.created -eq 0) (Json $generatedAgain)
  $inventory = Invoke-CurlCase "Venue Inventory" "Read owner inventory calendar" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory?from=2026-07-30T00%3A00%3A00.000Z&to=2026-07-31T00%3A00%3A00.000Z" @(200) "" $ownerOneHeaders
  $firstSlot = $inventory[0]
  $blocked = Invoke-CurlCase "Venue Inventory" "Block fixed Slot" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/block" @(201) (Json @{
    reason = "Maintenance"; slotId = $firstSlot.id; slotVersion = $firstSlot.version
  }) $ownerOneHeaders
  Invoke-CurlCase "Venue Inventory" "Reject stale fixed Slot block" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/block" @(409) (Json @{
    reason = "Duplicate"; slotId = $firstSlot.id; slotVersion = $firstSlot.version
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Inventory" "Release fixed Slot" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/$($firstSlot.id)/release" @(200) (Json @{
    version = $blocked.version; reason = "Maintenance complete"
  }) $ownerOneHeaders | Out-Null
  $openBlock = Invoke-CurlCase "Venue Inventory" "Create transactional open-time block" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/block" @(201) (Json @{
    reason = "Private event"; courtVersion = $courtMedia.version
    startsAt = "2026-07-30T00:30:00.000Z"; endsAt = "2026-07-30T01:30:00.000Z"
  }) $ownerOneHeaders
  Invoke-CurlCase "Venue Inventory" "Reject overlapping open-time block" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/block" @(409) (Json @{
    reason = "Overlap"; courtVersion = ($courtMedia.version + 1)
    startsAt = "2026-07-30T00:45:00.000Z"; endsAt = "2026-07-30T01:45:00.000Z"
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Inventory" "Release open-time block" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/$($openBlock.id)/release" @(204) (Json @{
    version = $openBlock.version; reason = "Event cancelled"
  }) $ownerOneHeaders | Out-Null

  Invoke-CurlCase "Payout Accounts" "Reject malformed tokenized payout metadata" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(400) (Json @{
    accountHolderName = "Curl Arena"; vaultProvider = "vault"; vaultAccountToken = "short"
    accountLast4 = "12"; bankName = "Example Bank"; ifscCode = "BAD"
  }) $ownerOneHeaders | Out-Null
  $payout = Invoke-CurlCase "Payout Accounts" "Create pending tokenized payout account" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(201) (Json @{
    accountHolderName = "Curl Arena Pvt Ltd"; vaultProvider = "bank-vault"
    vaultAccountToken = "tok_curl_account_$runId"; accountLast4 = "6789"
    bankName = "Example Bank"; ifscCode = "ABCD0123456"; accountNumber = "SHOULD_BE_STRIPPED"
  }) $ownerOneHeaders
  Add-SemanticCheck "Payout Accounts" "Payout response is masked and pending" (($payout.status -eq "PENDING") -and (-not ($payout.PSObject.Properties.Name -contains "vaultAccountToken"))) (Json $payout)
  Invoke-CurlCase "Payout Accounts" "Reject duplicate payout vault token" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(409) (Json @{
    accountHolderName = "Curl Arena Pvt Ltd"; vaultProvider = "bank-vault"
    vaultAccountToken = "tok_curl_account_$runId"; accountLast4 = "6789"
    bankName = "Example Bank"; ifscCode = "ABCD0123456"
  }) $ownerOneHeaders | Out-Null
  $payouts = Invoke-CurlCase "Payout Accounts" "List masked payout accounts" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Payout Accounts" "Admin verification fields remain empty" (($payouts[0].status -eq "PENDING") -and ($null -eq $payouts[0].verifiedAt)) (Json $payouts)

  Invoke-CurlCase "Partner Access" "Reject malformed Partner application" "POST" "/api/v1/partners/applications" @(400) (Json @{
    legalName = "X"; displayName = "X"; email = "bad"
  }) | Out-Null
  $partner = Invoke-CurlCase "Partner Access" "Create Partner application" "POST" "/api/v1/partners/applications" @(201) (Json @{
    legalName = "Curl Partner $runId Private Limited"; displayName = "Curl Partner $runId"; email = "curl-partner-$runId@example.com"
  })
  Invoke-CurlCase "Partner Access" "Reject duplicate Partner application" "POST" "/api/v1/partners/applications" @(409) (Json @{
    legalName = "Curl Partner $runId Private Limited"; displayName = "Curl Partner $runId"; email = "curl-partner-$runId@example.com"
  }) | Out-Null
  Invoke-CurlCase "Partner Access" "Reject key before sandbox approval" "POST" "/api/v1/partners/admin/$($partner.partnerId)/keys" @(409) (Json @{
    environment = "SANDBOX"; scopes = @("webhooks:write")
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Approve Partner sandbox" "POST" "/api/v1/partners/admin/$($partner.partnerId)/approve-sandbox" @(204) "" $adminHeaders | Out-Null
  $sandboxKey = Invoke-CurlCase "Partner Access" "Issue sandbox Partner key" "POST" "/api/v1/partners/admin/$($partner.partnerId)/keys" @(201) (Json @{
    environment = "SANDBOX"; scopes = @("webhooks:write")
  }) $adminHeaders
  Invoke-CurlCase "Partner Access" "Reject production approval without KYC/review" "POST" "/api/v1/partners/admin/$($partner.partnerId)/approve-production" @(409) "" $adminHeaders | Out-Null

  $partnerKyc = Invoke-CurlCase "Partner Access" "Admin creates Partner BUSINESS KYC" "POST" "/api/v1/kyc/admin/partners/$($partner.partnerId)/verifications" @(201) (Json @{
    verificationType = "BUSINESS"
  }) $adminHeaders
  Invoke-CurlCase "Partner Access" "Admin uploads Partner KYC document" "POST" "/api/v1/kyc/admin/partners/$($partner.partnerId)/verifications/$($partnerKyc.id)/documents?documentType=BUSINESS_REGISTRATION" @(201) "" $adminHeaders $mediaFile | Out-Null
  Invoke-CurlCase "Partner Access" "Admin submits Partner KYC" "POST" "/api/v1/kyc/admin/partners/$($partner.partnerId)/verifications/$($partnerKyc.id)/submit" @(204) "" $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Admin verifies Partner KYC" "PATCH" "/api/v1/kyc/admin/verifications/$($partnerKyc.id)/review" @(204) (Json @{
    status = "VERIFIED"; expiresAt = "2028-07-28T00:00:00.000Z"
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Record passed integration review" "PATCH" "/api/v1/partners/admin/$($partner.partnerId)/integration-review" @(204) (Json @{
    status = "PASSED"
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Approve Partner production" "POST" "/api/v1/partners/admin/$($partner.partnerId)/approve-production" @(204) "" $adminHeaders | Out-Null
  $productionKey = Invoke-CurlCase "Partner Access" "Issue production Partner key" "POST" "/api/v1/partners/admin/$($partner.partnerId)/keys" @(201) (Json @{
    environment = "PRODUCTION"; scopes = @("availability:read", "bookings:write")
  }) $adminHeaders

  $fixedHoldPath = "/api/v1/bookings/hold"
  $fixedHoldBody = Json @{
    bookingType = "FIXED_SLOT"; slotId = $firstSlot.id
  }
  $fixedHoldHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $fixedHoldBody
  Invoke-CurlCase "Booking Lifecycle" "Reject booking before effective Contract exists" "POST" $fixedHoldPath @(409) $fixedHoldBody $fixedHoldHeaders | Out-Null

  Invoke-CurlCase "Contracts" "Require Admin authentication for Contract list" "GET" "/api/v1/admin/contracts" @(401) | Out-Null
  Invoke-CurlCase "Contracts" "Reject Contract for an unknown Partner" "POST" "/api/v1/admin/contracts" @(409) (Json @{
    partnerId = "000000000000000000000001"; venueId = $ownerOne.venueId
    commissionRateBps = 1000; taxRateBps = 180
    settlementCycle = "WEEKLY"; settlementLagDays = 2
    allowedBookingModes = "BOTH"
    cancellationTerms = @{
      cancellationAllowed = $true; defaultRefundBps = 2500; releaseInventory = $false
    }
    refundRules = @()
    resaleCutoffMinutes = 60; effectiveFrom = "2026-07-28T00:00:00.000Z"
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Contracts" "Reject commission and tax above 100 percent" "POST" "/api/v1/admin/contracts" @(400) (Json @{
    partnerId = $partner.partnerId; venueId = $ownerOne.venueId
    commissionRateBps = 9500; taxRateBps = 600
    settlementCycle = "WEEKLY"; settlementLagDays = 2
    allowedBookingModes = "BOTH"
    cancellationTerms = @{
      cancellationAllowed = $true; defaultRefundBps = 2500; releaseInventory = $false
    }
    refundRules = @()
    resaleCutoffMinutes = 60; effectiveFrom = "2026-07-28T00:00:00.000Z"
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Contracts" "Reject duplicate refund thresholds" "POST" "/api/v1/admin/contracts" @(400) (Json @{
    partnerId = $partner.partnerId; venueId = $ownerOne.venueId
    commissionRateBps = 1000; taxRateBps = 180
    settlementCycle = "WEEKLY"; settlementLagDays = 2
    allowedBookingModes = "BOTH"
    cancellationTerms = @{
      cancellationAllowed = $true; defaultRefundBps = 2500; releaseInventory = $false
    }
    refundRules = @(
      @{ minMinutesBeforeStart = 60; refundBps = 8000; releaseInventory = $true },
      @{ minMinutesBeforeStart = 60; refundBps = 5000; releaseInventory = $false }
    )
    resaleCutoffMinutes = 60; effectiveFrom = "2026-07-28T00:00:00.000Z"
  }) $adminHeaders | Out-Null
  $contractOneBody = Json @{
    partnerId = $partner.partnerId; venueId = $ownerOne.venueId
    commissionRateBps = 1000; taxRateBps = 180
    settlementCycle = "WEEKLY"; settlementLagDays = 2
    allowedBookingModes = "BOTH"
    cancellationTerms = @{
      cancellationAllowed = $true; defaultRefundBps = 2500; releaseInventory = $false
    }
    refundRules = @(
      @{ minMinutesBeforeStart = 60; refundBps = 8000; releaseInventory = $true },
      @{ minMinutesBeforeStart = 0; refundBps = 2500; releaseInventory = $false }
    )
    resaleCutoffMinutes = 60; effectiveFrom = "2026-07-28T00:00:00.000Z"
  }
  $contractOne = Invoke-CurlCase "Contracts" "Create effective Contract version 1" "POST" "/api/v1/admin/contracts" @(201) $contractOneBody $adminHeaders
  Add-SemanticCheck "Contracts" "Version 1 preserves commercial and cancellation terms" (
    ($contractOne.termsVersion -eq 1) -and
    ($contractOne.commissionRateBps -eq 1000) -and
    ($contractOne.taxRateBps -eq 180) -and
    ($contractOne.allowedBookingModes -eq "BOTH") -and
    ($contractOne.refundRules.Count -eq 2)
  ) (Json $contractOne)
  $contractDetail = Invoke-CurlCase "Contracts" "Read Contract detail" "GET" "/api/v1/admin/contracts/$($contractOne.id)" @(200) "" $adminHeaders
  Add-SemanticCheck "Contracts" "Contract detail matches created relationship" (
    ($contractDetail.partnerId -eq $partner.partnerId) -and
    ($contractDetail.venueId -eq $ownerOne.venueId)
  ) (Json $contractDetail)
  $contractList = Invoke-CurlCase "Contracts" "Filter Contract versions by Partner and Venue" "GET" "/api/v1/admin/contracts?partnerId=$($partner.partnerId)&venueId=$($ownerOne.venueId)" @(200) "" $adminHeaders
  Add-SemanticCheck "Contracts" "Filtered Contract list contains version 1" (
    ($contractList.Count -eq 1) -and ($contractList[0].id -eq $contractOne.id)
  ) (Json $contractList)
  Invoke-CurlCase "Contracts" "Reject a non-increasing effective date" "POST" "/api/v1/admin/contracts" @(409) $contractOneBody $adminHeaders | Out-Null
  Invoke-CurlCase "Contracts" "Return not found for unknown Contract detail" "GET" "/api/v1/admin/contracts/000000000000000000000002" @(404) "" $adminHeaders | Out-Null
  Invoke-CurlCase "Contracts" "Expose no Venue Owner Contract mutation route" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/contracts" @(404) $contractOneBody $ownerOneHeaders | Out-Null

  Invoke-CurlCase "Booking Lifecycle" "Reject unsigned fixed-slot hold" "POST" $fixedHoldPath @(401) $fixedHoldBody | Out-Null
  $sandboxHoldHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "POST" $fixedHoldPath $fixedHoldBody
  Invoke-CurlCase "Booking Lifecycle" "Reject Partner key without bookings write scope" "POST" $fixedHoldPath @(403) $fixedHoldBody $sandboxHoldHeaders | Out-Null
  $invalidHoldBody = Json @{ bookingType = "FIXED_SLOT" }
  $invalidHoldHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $invalidHoldBody
  Invoke-CurlCase "Booking Lifecycle" "Reject incomplete fixed-slot hold shape" "POST" $fixedHoldPath @(400) $invalidHoldBody $invalidHoldHeaders | Out-Null
  $fixedHoldHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $fixedHoldBody
  $fixedHold = Invoke-CurlCase "Booking Lifecycle" "Hold available fixed Slot" "POST" $fixedHoldPath @(201) $fixedHoldBody $fixedHoldHeaders
  Add-SemanticCheck "Booking Lifecycle" "Fixed hold returns durable identifiers, price, and expiry" (
    ($fixedHold.slotId -eq $firstSlot.id) -and
    ($fixedHold.bookingType -eq "FIXED_SLOT") -and
    ($fixedHold.priceMinor -eq 125000) -and
    ($fixedHold.currency -eq "INR") -and
    (-not [string]::IsNullOrWhiteSpace($fixedHold.holdId)) -and
    ([datetime]$fixedHold.expiresAt -gt [datetime]::UtcNow)
  ) (Json $fixedHold)
  $duplicateHoldHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $fixedHoldBody
  Invoke-CurlCase "Booking Lifecycle" "Reject a competing fixed-slot hold" "POST" $fixedHoldPath @(409) $fixedHoldBody $duplicateHoldHeaders | Out-Null

  $confirmPath = "/api/v1/bookings/confirm"
  $confirmBody = Json @{
    holdId = $fixedHold.holdId
    externalBookingReference = "curl-fixed-booking-1"
    customerReference = "customer-fixed-1"
    partnerPaymentReference = "payment-fixed-1"
  }
  $confirmHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $confirmPath $confirmBody
  Invoke-CurlCase "Booking Lifecycle" "Require Idempotency-Key for confirmation" "POST" $confirmPath @(400) $confirmBody $confirmHeaders | Out-Null
  $confirmHeaders["Idempotency-Key"] = "curl-confirm-fixed-1"
  $fixedBooking = Invoke-CurlCase "Booking Lifecycle" "Confirm fixed-slot Booking" "POST" $confirmPath @(201) $confirmBody $confirmHeaders
  Add-SemanticCheck "Booking Lifecycle" "Confirmation snapshots correct commercial amounts" (
    ($fixedBooking.status -eq "CONFIRMED") -and
    ($fixedBooking.grossAmountMinor -eq 125000) -and
    ($fixedBooking.commissionAmountMinor -eq 12500) -and
    ($fixedBooking.taxAmountMinor -eq 2250) -and
    ($fixedBooking.venueNetAmountMinor -eq 110250)
  ) (Json $fixedBooking)
  $confirmReplayHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $confirmPath $confirmBody
  $confirmReplayHeaders["Idempotency-Key"] = "curl-confirm-fixed-1"
  $fixedReplay = Invoke-CurlCase "Booking Lifecycle" "Replay fixed confirmation idempotently" "POST" $confirmPath @(201) $confirmBody $confirmReplayHeaders
  Add-SemanticCheck "Booking Lifecycle" "Confirmation replay returns original Booking" (
    $fixedReplay.bookingId -eq $fixedBooking.bookingId
  ) (Json $fixedReplay)
  $confirmChangedBody = Json @{
    holdId = $fixedHold.holdId
    externalBookingReference = "curl-fixed-booking-changed"
  }
  $confirmChangedHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $confirmPath $confirmChangedBody
  $confirmChangedHeaders["Idempotency-Key"] = "curl-confirm-fixed-1"
  Invoke-CurlCase "Booking Lifecycle" "Reject confirmation key reuse with changed content" "POST" $confirmPath @(409) $confirmChangedBody $confirmChangedHeaders | Out-Null
  $bookedHoldHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $fixedHoldBody
  Invoke-CurlCase "Booking Lifecycle" "Reject hold on an already booked Slot" "POST" $fixedHoldPath @(409) $fixedHoldBody $bookedHoldHeaders | Out-Null

  $ownerConfirmed = Invoke-CurlCase "Owner Bookings" "List confirmed Venue bookings with filters" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings?courtId=$($court.id)&status=CONFIRMED&page=1&limit=10" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Owner Bookings" "Owner list exposes Partner reference and scoped Booking" (
    ($ownerConfirmed.pagination.total -eq 1) -and
    ($ownerConfirmed.items[0].id -eq $fixedBooking.bookingId) -and
    ($ownerConfirmed.items[0].externalBookingReference -eq "curl-fixed-booking-1")
  ) (Json $ownerConfirmed)
  Invoke-CurlCase "Owner Bookings" "Prevent cross-Venue Owner booking access" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings" @(403) "" $ownerTwoHeaders | Out-Null
  Invoke-CurlCase "Owner Bookings" "Reject an inverted booking date filter" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings?from=2026-07-31T00%3A00%3A00.000Z&to=2026-07-30T00%3A00%3A00.000Z" @(400) "" $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Owner Bookings" "Expose no Venue Owner booking creation route" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings" @(404) (Json @{}) $ownerOneHeaders | Out-Null
  $fixedDetail = Invoke-CurlCase "Owner Bookings" "Read confirmed Booking detail" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings/$($fixedBooking.bookingId)" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Owner Bookings" "Booking detail references Contract version 1" (
    ($fixedDetail.contractId -eq $contractOne.id) -and ($fixedDetail.cancellation -eq $null)
  ) (Json $fixedDetail)

  $contractTwo = Invoke-CurlCase "Contracts" "Create future Contract version 2" "POST" "/api/v1/admin/contracts" @(201) (Json @{
    partnerId = $partner.partnerId; venueId = $ownerOne.venueId
    commissionRateBps = 2000; taxRateBps = 360
    settlementCycle = "MONTHLY"; settlementLagDays = 5
    allowedBookingModes = "OPEN_TIME"
    cancellationTerms = @{
      cancellationAllowed = $false; defaultRefundBps = 0; releaseInventory = $false
    }
    refundRules = @()
    resaleCutoffMinutes = 0; effectiveFrom = "2026-08-01T00:00:00.000Z"
  }) $adminHeaders
  Add-SemanticCheck "Contracts" "Future Contract increments immutable terms version" (
    ($contractTwo.termsVersion -eq 2) -and ($contractTwo.allowedBookingModes -eq "OPEN_TIME")
  ) (Json $contractTwo)
  $versionedContracts = Invoke-CurlCase "Contracts" "List complete Contract version history" "GET" "/api/v1/admin/contracts?partnerId=$($partner.partnerId)&venueId=$($ownerOne.venueId)" @(200) "" $adminHeaders
  $versionOneFromList = @($versionedContracts | Where-Object { $_.id -eq $contractOne.id })[0]
  Add-SemanticCheck "Contracts" "Version 1 is closed at version 2 effective time" (
    ($versionedContracts.Count -eq 2) -and
    ($versionOneFromList.effectiveTo -eq "2026-08-01T00:00:00.000Z")
  ) (Json $versionedContracts)
  $fixedDetailAfterTermsChange = Invoke-CurlCase "Owner Bookings" "Read Booking after future Contract change" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings/$($fixedBooking.bookingId)" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Owner Bookings" "Existing Booking commercial snapshot remains unchanged" (
    ($fixedDetailAfterTermsChange.contractId -eq $contractOne.id) -and
    ($fixedDetailAfterTermsChange.commissionAmountMinor -eq 12500) -and
    ($fixedDetailAfterTermsChange.taxAmountMinor -eq 2250) -and
    ($fixedDetailAfterTermsChange.venueNetAmountMinor -eq 110250)
  ) (Json $fixedDetailAfterTermsChange)

  $cancelPath = "/api/v1/bookings/$($fixedBooking.bookingId)/cancel"
  $cancelBody = Json @{
    reasonCode = "CUSTOMER_REQUEST"; reasonText = "Customer changed plans"
  }
  $cancelHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $cancelPath $cancelBody
  Invoke-CurlCase "Booking Lifecycle" "Require Idempotency-Key for cancellation" "POST" $cancelPath @(400) $cancelBody $cancelHeaders | Out-Null
  $cancelHeaders["Idempotency-Key"] = "curl-cancel-fixed-1"
  $fixedCancellation = Invoke-CurlCase "Booking Lifecycle" "Cancel confirmed fixed-slot Booking" "POST" $cancelPath @(201) $cancelBody $cancelHeaders
  Add-SemanticCheck "Booking Lifecycle" "Cancellation applies snapshotted refund and releases inventory" (
    ($fixedCancellation.status -eq "CANCELLED") -and
    ($fixedCancellation.refundPercent -eq 80) -and
    ($fixedCancellation.refundAmountMinor -eq 100000) -and
    ($fixedCancellation.slotDisposition -eq "RELEASE_TO_INVENTORY")
  ) (Json $fixedCancellation)
  $cancelReplayHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $cancelPath $cancelBody
  $cancelReplayHeaders["Idempotency-Key"] = "curl-cancel-fixed-1"
  $fixedCancellationReplay = Invoke-CurlCase "Booking Lifecycle" "Replay cancellation idempotently" "POST" $cancelPath @(201) $cancelBody $cancelReplayHeaders
  Add-SemanticCheck "Booking Lifecycle" "Cancellation replay returns original result" (
    ($fixedCancellationReplay.bookingId -eq $fixedBooking.bookingId) -and
    ($fixedCancellationReplay.cancelledAt -eq $fixedCancellation.cancelledAt)
  ) (Json $fixedCancellationReplay)
  $cancelChangedBody = Json @{ reasonCode = "PARTNER_REQUEST" }
  $cancelChangedHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $cancelPath $cancelChangedBody
  $cancelChangedHeaders["Idempotency-Key"] = "curl-cancel-fixed-1"
  Invoke-CurlCase "Booking Lifecycle" "Reject cancellation key reuse with changed content" "POST" $cancelPath @(409) $cancelChangedBody $cancelChangedHeaders | Out-Null
  $fixedCancelledDetail = Invoke-CurlCase "Owner Bookings" "Read cancellation outcome in Owner detail" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings/$($fixedBooking.bookingId)" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Owner Bookings" "Owner detail contains cancellation reason and refund" (
    ($fixedCancelledDetail.status -eq "CANCELLED") -and
    ($fixedCancelledDetail.cancellation.reasonCode -eq "CUSTOMER_REQUEST") -and
    ($fixedCancelledDetail.cancellation.refundAmountMinor -eq 100000)
  ) (Json $fixedCancelledDetail)
  Invoke-CurlCase "Booking Audit" "Require Admin authentication for Booking audit" "GET" "/api/v1/bookings/admin/$($fixedBooking.bookingId)/audit" @(401) | Out-Null
  $fixedAudit = Invoke-CurlCase "Booking Audit" "Read chronological Booking audit trail" "GET" "/api/v1/bookings/admin/$($fixedBooking.bookingId)/audit" @(200) "" $adminHeaders
  Add-SemanticCheck "Booking Audit" "Audit contains confirmation then cancellation" (
    ($fixedAudit.auditHistory.Count -eq 2) -and
    ($fixedAudit.auditHistory[0].eventType -eq "BOOKING_CONFIRMED") -and
    ($fixedAudit.auditHistory[1].eventType -eq "BOOKING_CANCELLED") -and
    ([datetime]$fixedAudit.auditHistory[0].occurredAt -le [datetime]$fixedAudit.auditHistory[1].occurredAt)
  ) (Json $fixedAudit)
  $inventoryAfterCancel = Invoke-CurlCase "Booking Lifecycle" "Read inventory after fixed cancellation" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory?from=2026-07-30T00%3A00%3A00.000Z&to=2026-07-31T00%3A00%3A00.000Z" @(200) "" $ownerOneHeaders
  $releasedFixedSlot = @($inventoryAfterCancel | Where-Object { $_.id -eq $firstSlot.id })[0]
  Add-SemanticCheck "Booking Lifecycle" "Cancelled fixed Slot is available for resale" (
    $releasedFixedSlot.status -eq "AVAILABLE"
  ) (Json $releasedFixedSlot)

  $invalidOpenBody = Json @{
    bookingType = "OPEN_TIME"; venueId = $ownerOne.venueId; courtId = $court.id
    startsAt = "2026-07-30T01:30:00.000Z"; endsAt = "2026-07-30T02:00:00.000Z"
  }
  $invalidOpenHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $invalidOpenBody
  Invoke-CurlCase "Booking Lifecycle" "Reject open-time duration below minimum" "POST" $fixedHoldPath @(400) $invalidOpenBody $invalidOpenHeaders | Out-Null
  $openHoldBody = Json @{
    bookingType = "OPEN_TIME"; venueId = $ownerOne.venueId; courtId = $court.id
    startsAt = "2026-07-30T01:30:00.000Z"; endsAt = "2026-07-30T02:30:00.000Z"
  }
  $openHoldHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $openHoldBody
  $openHold = Invoke-CurlCase "Booking Lifecycle" "Hold valid open-time interval" "POST" $fixedHoldPath @(201) $openHoldBody $openHoldHeaders
  Add-SemanticCheck "Booking Lifecycle" "Open-time hold calculates the hourly price" (
    ($openHold.bookingType -eq "OPEN_TIME") -and ($openHold.priceMinor -eq 125000)
  ) (Json $openHold)
  $openConflictHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $fixedHoldPath $openHoldBody
  Invoke-CurlCase "Booking Lifecycle" "Reject overlapping open-time hold" "POST" $fixedHoldPath @(409) $openHoldBody $openConflictHeaders | Out-Null
  $openConfirmBody = Json @{
    holdId = $openHold.holdId; externalBookingReference = "curl-open-booking-1"
  }
  $openConfirmHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $confirmPath $openConfirmBody
  $openConfirmHeaders["Idempotency-Key"] = "curl-confirm-open-1"
  $openBooking = Invoke-CurlCase "Booking Lifecycle" "Confirm open-time Booking" "POST" $confirmPath @(201) $openConfirmBody $openConfirmHeaders
  Add-SemanticCheck "Booking Lifecycle" "Open-time confirmation uses currently effective version 1" (
    ($openBooking.bookingType -eq "OPEN_TIME") -and
    ($openBooking.commissionAmountMinor -eq 12500) -and
    ($openBooking.taxAmountMinor -eq 2250)
  ) (Json $openBooking)
  $openCancelPath = "/api/v1/bookings/$($openBooking.bookingId)/cancel"
  $openCancelBody = Json @{ reasonCode = "CUSTOMER_REQUEST" }
  $openCancelHeaders = New-PartnerHeaders $productionKey.apiKey $productionKey.signingSecret "POST" $openCancelPath $openCancelBody
  $openCancelHeaders["Idempotency-Key"] = "curl-cancel-open-1"
  $openCancellation = Invoke-CurlCase "Booking Lifecycle" "Cancel open-time Booking" "POST" $openCancelPath @(201) $openCancelBody $openCancelHeaders
  Add-SemanticCheck "Booking Lifecycle" "Open-time cancellation releases provisional inventory" (
    ($openCancellation.refundPercent -eq 80) -and
    ($openCancellation.slotDisposition -eq "RELEASE_TO_INVENTORY")
  ) (Json $openCancellation)
  $cancelledOwnerList = Invoke-CurlCase "Owner Bookings" "Filter cancelled Venue bookings" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/bookings?status=CANCELLED&limit=10" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Owner Bookings" "Owner sees both cancelled booking modes" (
    ($cancelledOwnerList.pagination.total -eq 2) -and
    (@($cancelledOwnerList.items | Where-Object { $_.bookingType -eq "FIXED_SLOT" }).Count -eq 1) -and
    (@($cancelledOwnerList.items | Where-Object { $_.bookingType -eq "OPEN_TIME" }).Count -eq 1)
  ) (Json $cancelledOwnerList)

  $webhookPath = "/api/v1/partners/webhooks"
  $webhookBody = Json @{ url = "https://partner.example.com/gds"; subscribedEvents = @("booking.confirmed") }
  Invoke-CurlCase "Partner Webhooks" "Reject unsigned Partner request" "POST" $webhookPath @(401) $webhookBody | Out-Null
  $badSignatureHeaders = @{
    "x-api-key" = $sandboxKey.apiKey; "x-signature" = "sha256=00"; "x-timestamp" = "$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  }
  Invoke-CurlCase "Partner Webhooks" "Reject invalid HMAC signature" "POST" $webhookPath @(401) $webhookBody $badSignatureHeaders | Out-Null
  $staleHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "POST" $webhookPath $webhookBody ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 1000)
  Invoke-CurlCase "Partner Webhooks" "Reject stale signed timestamp" "POST" $webhookPath @(401) $webhookBody $staleHeaders | Out-Null
  $httpBody = Json @{ url = "http://partner.example.com/gds"; subscribedEvents = @("booking.confirmed") }
  $httpHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "POST" $webhookPath $httpBody
  Invoke-CurlCase "Partner Webhooks" "Require HTTPS webhook URL" "POST" $webhookPath @(400) $httpBody $httpHeaders | Out-Null
  $webhookHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "POST" $webhookPath $webhookBody
  $webhook = Invoke-CurlCase "Partner Webhooks" "Register signed Partner webhook" "POST" $webhookPath @(201) $webhookBody $webhookHeaders
  $duplicateHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "POST" $webhookPath $webhookBody
  Invoke-CurlCase "Partner Webhooks" "Reject duplicate Partner webhook" "POST" $webhookPath @(409) $webhookBody $duplicateHeaders | Out-Null
  Invoke-CurlCase "Partner Webhooks" "Admin verifies Partner webhook" "POST" "/api/v1/partners/admin/webhooks/$($webhook.webhookId)/verify" @(204) "" $adminHeaders | Out-Null
  $deletePath = "/api/v1/partners/webhooks/$($webhook.webhookId)"
  $deleteHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "DELETE" $deletePath ""
  Invoke-CurlCase "Partner Webhooks" "Partner disables own webhook" "DELETE" $deletePath @(204) "" $deleteHeaders | Out-Null
  $deleteAgainHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "DELETE" $deletePath ""
  Invoke-CurlCase "Partner Webhooks" "Reject repeated webhook disable" "DELETE" $deletePath @(409) "" $deleteAgainHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Admin revokes Partner key" "DELETE" "/api/v1/partners/admin/keys/$($sandboxKey.keyId)" @(204) "" $adminHeaders | Out-Null
  $revokedHeaders = New-PartnerHeaders $sandboxKey.apiKey $sandboxKey.signingSecret "POST" $webhookPath $webhookBody
  Invoke-CurlCase "Partner Webhooks" "Reject revoked Partner key" "POST" $webhookPath @(401) $webhookBody $revokedHeaders | Out-Null

  Invoke-CurlCase "Owner Identity" "Logout revokes owner session" "POST" "/api/v1/auth/venue-owners/logout" @(204) "" $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Owner Identity" "Reject revoked owner session" "GET" "/api/v1/auth/venue-owners/me" @(401) "" $ownerOneHeaders | Out-Null

  $failed = @($script:Results | Where-Object { -not $_.Passed })
  $groups = $script:Results | Group-Object Module
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# Full API cURL Test Report")
  $lines.Add("")
  $lines.Add("- Executed: $([DateTimeOffset]::Now.ToString("yyyy-MM-dd HH:mm:ss zzz"))")
  $lines.Add("- Target: isolated local API and temporary MongoDB database")
  $lines.Add("- Media: local test adapter; no external Cloudinary writes")
  $lines.Add("- Transport: `curl.exe` for every HTTP request")
  $lines.Add("- Total checks: $($script:Results.Count)")
  $lines.Add("- Passed: $(@($script:Results | Where-Object Passed).Count)")
  $lines.Add("- Failed: $($failed.Count)")
  $lines.Add("- Sensitive tokens and secrets: redacted")
  $lines.Add("")
  $lines.Add("## Module Summary")
  $lines.Add("")
  $lines.Add("| Module | Checks | Passed | Failed |")
  $lines.Add("|---|---:|---:|---:|")
  foreach ($group in $groups) {
    $passedCount = @($group.Group | Where-Object Passed).Count
    $failedCount = $group.Count - $passedCount
    $lines.Add("| $($group.Name) | $($group.Count) | $passedCount | $failedCount |")
  }
  foreach ($group in $groups) {
    $lines.Add("")
    $lines.Add("## $($group.Name)")
    $lines.Add("")
    $lines.Add("| # | Test case | Request | Expected | Actual | Result | Evidence |")
    $lines.Add("|---:|---|---|---:|---:|---|---|")
    foreach ($result in $group.Group) {
      $evidence = ($result.Evidence -replace "\|", "\|" -replace "`r?`n", " ")
      $outcome = if ($result.Passed) { "PASS" } else { "FAIL" }
      $lines.Add("| $($result.Number) | $($result.Case) | ``$($result.Method) $($result.Path)`` | $($result.Expected) | $($result.Actual) | $outcome | $evidence |")
    }
  }
  $lines.Add("")
  $lines.Add("## Deferred Actor APIs")
  $lines.Add("")
  $lines.Add("Partner availability/search and Admin payout-verification endpoints are intentionally not registered in the current Venue Owner-first phase. Their absence is architectural scope, not a cURL failure. Partner identity/onboarding/webhook APIs already present in the application were tested.")
  $lines.Add("")
  $lines.Add("## Conclusion")
  $lines.Add("")
  $conclusion = if ($failed.Count -eq 0) {
    "All implemented HTTP modules and tested edge flows passed."
  } else {
    "$($failed.Count) checks failed and require remediation."
  }
  $lines.Add($conclusion)

  if (-not $ReportPath) {
    $ReportPath = Join-Path (Get-Location) "docs/curl-api-test-report-2026-07-28.md"
  }
  [System.IO.File]::WriteAllLines($ReportPath, $lines)
  Write-Output "CURL_TEST_REPORT=$ReportPath"
  Write-Output "CURL_TEST_TOTAL=$($script:Results.Count)"
  Write-Output "CURL_TEST_PASSED=$(@($script:Results | Where-Object Passed).Count)"
  Write-Output "CURL_TEST_FAILED=$($failed.Count)"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
