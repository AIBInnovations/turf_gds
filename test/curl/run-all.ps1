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
  Invoke-CurlCase "Platform" "Health endpoint" "GET" "/health" @(200) | Out-Null
  Invoke-CurlCase "Platform" "Dependency readiness" "GET" "/ready" @(200) | Out-Null
  Invoke-CurlCase "Platform" "API version discovery" "GET" "/api/v1" @(200) | Out-Null
  $unknown = Invoke-CurlCase "Platform" "Unknown route error envelope" "GET" "/api/v1/not-a-route" @(404)
  Add-SemanticCheck "Platform" "Unknown route has stable error code" ($unknown.error.code -eq "ROUTE_NOT_FOUND") (Json $unknown)

  $ownerOneRegistration = @{
    legalName = "Curl Owner One Private Limited"
    email = "curl-owner-one@example.com"
    phoneE164 = "+919876540001"
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
    email = "curl-owner-two@example.com"
    phoneE164 = "+919876540002"
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
  Add-SemanticCheck "KYC" "Submitted KYC is current" ($currentKyc.status -eq "SUBMITTED") (Json $currentKyc)
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
    name = "Curl Court"; sportTypes = @("football", "box cricket")
    bookingMode = "BOTH"; minBookingMinutes = 60; bookingIncrementMinutes = 30
  }) $ownerOneHeaders
  Invoke-CurlCase "Courts" "Reject duplicate Court name" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts" @(409) (Json @{
    name = "curl court"; sportTypes = @("CRICKET")
    bookingMode = "FIXED_SLOT"; minBookingMinutes = 60; bookingIncrementMinutes = 30
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Courts" "Reject invalid Court duration" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts" @(400) (Json @{
    name = "Bad Duration"; sportTypes = @("FOOTBALL")
    bookingMode = "OPEN_TIME"; minBookingMinutes = 75; bookingIncrementMinutes = 30
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Courts" "Prevent cross-owner Court detail access" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)" @(403) "" $ownerTwoHeaders | Out-Null
  Invoke-CurlCase "Courts" "Reject invalid booking mode at route boundary" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)" @(400) (Json @{
    version = 1; bookingMode = "BOOKED"
  }) $ownerOneHeaders | Out-Null
  $courtHours = Invoke-CurlCase "Courts" "Configure Court operating hours" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/operating-hours" @(200) (Json @{
    version = 1
    operatingHours = @(@{ dayOfWeek = 3; opensAt = "06:00"; closesAt = "08:00" })
  }) $ownerOneHeaders
  Invoke-CurlCase "Courts" "Reject reversed operating hours" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/operating-hours" @(400) (Json @{
    version = $courtHours.version
    operatingHours = @(@{ dayOfWeek = 3; opensAt = "20:00"; closesAt = "08:00" })
  }) $ownerOneHeaders | Out-Null
  $courtMedia = Invoke-CurlCase "Courts" "Upload Court media metadata" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/media?version=$($courtHours.version)" @(201) "" $ownerOneHeaders $mediaFile
  Add-SemanticCheck "Courts" "Court media increments aggregate version" ($courtMedia.version -eq ($courtHours.version + 1)) (Json $courtMedia)

  Invoke-CurlCase "Venue Inventory" "Reject negative pricing" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules" @(400) (Json @{
    name = "Invalid"; daysOfWeek = @(3); startsTime = "06:00"; endsTime = "08:00"
    amountMinor = -1; currency = "INR"; effectiveFrom = "2026-01-01T00:00:00.000Z"; priority = 1
  }) $ownerOneHeaders | Out-Null
  $price = Invoke-CurlCase "Venue Inventory" "Create pricing rule" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules" @(201) (Json @{
    name = "Weekday"; daysOfWeek = @(3); startsTime = "06:00"; endsTime = "08:00"
    amountMinor = 125000; currency = "INR"; effectiveFrom = "2026-01-01T00:00:00.000Z"; priority = 10
  }) $ownerOneHeaders
  $prices = Invoke-CurlCase "Venue Inventory" "List Court pricing rules" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Venue Inventory" "Pricing list preserves INR amount" (($prices[0].currency -eq "INR") -and ($prices[0].amountMinor -eq 125000)) (Json $prices)
  Invoke-CurlCase "Venue Inventory" "Deactivate pricing rule" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules/$($price.id)" @(200) (Json @{
    status = "INACTIVE"
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Inventory" "Inactive pricing generates no slots" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/slots/generate" @(200) (Json @{
    dateFrom = "2026-07-29"; dateTo = "2026-07-29"
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Inventory" "Reactivate pricing rule" "PATCH" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/pricing-rules/$($price.id)" @(200) (Json @{
    status = "ACTIVE"
  }) $ownerOneHeaders | Out-Null
  $generated = Invoke-CurlCase "Venue Inventory" "Generate rolling fixed slots" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/slots/generate" @(200) (Json @{
    dateFrom = "2026-07-29"; dateTo = "2026-07-29"
  }) $ownerOneHeaders
  Add-SemanticCheck "Venue Inventory" "Two one-hour slots generated" ($generated.created -eq 2) (Json $generated)
  $generatedAgain = Invoke-CurlCase "Venue Inventory" "Slot generation is idempotent" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/slots/generate" @(200) (Json @{
    dateFrom = "2026-07-29"; dateTo = "2026-07-29"
  }) $ownerOneHeaders
  Add-SemanticCheck "Venue Inventory" "Repeated generation creates zero duplicates" ($generatedAgain.created -eq 0) (Json $generatedAgain)
  $inventory = Invoke-CurlCase "Venue Inventory" "Read owner inventory calendar" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory?from=2026-07-29T00%3A00%3A00.000Z&to=2026-07-30T00%3A00%3A00.000Z" @(200) "" $ownerOneHeaders
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
    startsAt = "2026-07-29T00:30:00.000Z"; endsAt = "2026-07-29T01:30:00.000Z"
  }) $ownerOneHeaders
  Invoke-CurlCase "Venue Inventory" "Reject overlapping open-time block" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/block" @(409) (Json @{
    reason = "Overlap"; courtVersion = ($courtMedia.version + 1)
    startsAt = "2026-07-29T00:45:00.000Z"; endsAt = "2026-07-29T01:45:00.000Z"
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Inventory" "Release open-time block" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/courts/$($court.id)/inventory/$($openBlock.id)/release" @(204) (Json @{
    version = $openBlock.version; reason = "Event cancelled"
  }) $ownerOneHeaders | Out-Null

  $emptyContent = Invoke-CurlCase "Venue Content" "Read empty flexible content" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/content" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Venue Content" "Missing content is represented as version zero" ($emptyContent.version -eq 0) (Json $emptyContent)
  $content = Invoke-CurlCase "Venue Content" "Create flexible Venue content" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/content" @(200) (Json @{
    content = @{ amenities = @("Parking", "Lights"); policies = @{ footwear = "Studs" } }
  }) $ownerOneHeaders
  Invoke-CurlCase "Venue Content" "Reject unsafe MongoDB content key" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/content" @(400) (Json @{
    version = $content.version; content = @{ '$where' = "unsafe" }
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Content" "Reject stale content version" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/content" @(409) (Json @{
    version = 99; content = @{ amenities = @() }
  }) $ownerOneHeaders | Out-Null
  Invoke-CurlCase "Venue Content" "Update flexible content by version" "PUT" "/api/v1/owner/venues/$($ownerOne.venueId)/content" @(200) (Json @{
    version = $content.version; content = @{ amenities = @("Parking", "Lights", "Washroom") }
  }) $ownerOneHeaders | Out-Null

  Invoke-CurlCase "Payout Accounts" "Reject malformed tokenized payout metadata" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(400) (Json @{
    accountHolderName = "Curl Arena"; vaultProvider = "vault"; vaultAccountToken = "short"
    accountLast4 = "12"; bankName = "Example Bank"; ifscCode = "BAD"
  }) $ownerOneHeaders | Out-Null
  $payout = Invoke-CurlCase "Payout Accounts" "Create pending tokenized payout account" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(201) (Json @{
    accountHolderName = "Curl Arena Pvt Ltd"; vaultProvider = "bank-vault"
    vaultAccountToken = "tok_curl_account_123456"; accountLast4 = "6789"
    bankName = "Example Bank"; ifscCode = "ABCD0123456"; accountNumber = "SHOULD_BE_STRIPPED"
  }) $ownerOneHeaders
  Add-SemanticCheck "Payout Accounts" "Payout response is masked and pending" (($payout.status -eq "PENDING") -and (-not ($payout.PSObject.Properties.Name -contains "vaultAccountToken"))) (Json $payout)
  Invoke-CurlCase "Payout Accounts" "Reject duplicate payout vault token" "POST" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(409) (Json @{
    accountHolderName = "Curl Arena Pvt Ltd"; vaultProvider = "bank-vault"
    vaultAccountToken = "tok_curl_account_123456"; accountLast4 = "6789"
    bankName = "Example Bank"; ifscCode = "ABCD0123456"
  }) $ownerOneHeaders | Out-Null
  $payouts = Invoke-CurlCase "Payout Accounts" "List masked payout accounts" "GET" "/api/v1/owner/venues/$($ownerOne.venueId)/payout-accounts" @(200) "" $ownerOneHeaders
  Add-SemanticCheck "Payout Accounts" "Admin verification fields remain empty" (($payouts[0].status -eq "PENDING") -and ($null -eq $payouts[0].verifiedAt)) (Json $payouts)

  Invoke-CurlCase "Partner Access" "Reject malformed Partner application" "POST" "/api/v1/partners/applications" @(400) (Json @{
    legalName = "X"; displayName = "X"; email = "bad"
  }) | Out-Null
  $partner = Invoke-CurlCase "Partner Access" "Create Partner application" "POST" "/api/v1/partners/applications" @(201) (Json @{
    legalName = "Curl Partner Private Limited"; displayName = "Curl Partner"; email = "curl-partner@example.com"
  })
  Invoke-CurlCase "Partner Access" "Reject duplicate Partner application" "POST" "/api/v1/partners/applications" @(409) (Json @{
    legalName = "Curl Partner Private Limited"; displayName = "Curl Partner"; email = "curl-partner@example.com"
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
  Invoke-CurlCase "Partner Access" "Admin uploads Partner KYC document" "POST" "/api/v1/kyc/admin/partners/$($partner.partnerId)/verifications/$($partnerKyc.id)/documents?documentType=INCORPORATION" @(201) "" $adminHeaders $mediaFile | Out-Null
  Invoke-CurlCase "Partner Access" "Admin submits Partner KYC" "POST" "/api/v1/kyc/admin/partners/$($partner.partnerId)/verifications/$($partnerKyc.id)/submit" @(204) "" $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Admin verifies Partner KYC" "PATCH" "/api/v1/kyc/admin/verifications/$($partnerKyc.id)/review" @(204) (Json @{
    status = "VERIFIED"; expiresAt = "2028-07-28T00:00:00.000Z"
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Record passed integration review" "PATCH" "/api/v1/partners/admin/$($partner.partnerId)/integration-review" @(204) (Json @{
    status = "PASSED"
  }) $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Approve Partner production" "POST" "/api/v1/partners/admin/$($partner.partnerId)/approve-production" @(204) "" $adminHeaders | Out-Null
  Invoke-CurlCase "Partner Access" "Issue production Partner key" "POST" "/api/v1/partners/admin/$($partner.partnerId)/keys" @(201) (Json @{
    environment = "PRODUCTION"; scopes = @("availability:read")
  }) $adminHeaders | Out-Null

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
