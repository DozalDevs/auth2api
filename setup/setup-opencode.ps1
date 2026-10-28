# Connects OpenCode (the desktop app and the command line tool) on this Windows computer to the
# DozalDevs AI relay, using the personal API key you were given.
#
# Run it:       paste the one-line command you were given into PowerShell
# Check later:  the same command with -Check on the end (changes nothing; proves your key and models work)
# Re-run it any time: it updates the setup in place (for example after you are given more models).
#
# What it changes, and nothing else:
#   ~\.config\opencode\opencode.json            adds a "dozaldevs-relay" provider (other settings are kept)
#   ~\.local\share\opencode\dozaldevs-relay.key your key, in a file only you can read
# The settings file is backed up next to the original before it is changed.

param([switch]$Check)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$RelayUrlDefault = '__RELAY_URL__'
if ($RelayUrlDefault.StartsWith('__')) { $RelayUrlDefault = 'https://dozaldevs-codex-relay-2.fly.dev' }
$RelayUrl = if ($env:RELAY_URL) { $env:RELAY_URL } else { $RelayUrlDefault }
$RelayUrl = $RelayUrl.TrimEnd('/')
$ProviderId = 'dozaldevs-relay'
$ProviderName = 'DozalDevs AI Relay'
$Candidates = @('gpt-6-luna', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra')

$ConfigHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
$DataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $HOME '.local/share' }
$ConfigFile = Join-Path (Join-Path $ConfigHome 'opencode') 'opencode.json'
$KeyFile = Join-Path (Join-Path $DataHome 'opencode') 'dozaldevs-relay.key'
$KeyFileForJson = $KeyFile.Replace('\', '/')
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ReleaseDate = if ($env:RELAY_RELEASE_DATE) { $env:RELAY_RELEASE_DATE } else { (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') }
$StaleDays = 150
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say([string]$Text) { Write-Host $Text }
function Ok([string]$Text) { Write-Host "[ok] $Text" }
function Warn([string]$Text) { Write-Host "[!]  $Text" }
function Die([string]$Text) {
    if ($Check) { throw "`nCheck failed: $Text" }
    throw "`nSetup stopped: $Text`nNothing was changed."
}

function Invoke-Relay([string]$Method, [string]$Path, [string]$Json) {
    $req = [System.Net.HttpWebRequest]::Create($RelayUrl + $Path)
    $req.Method = $Method
    $req.UserAgent = 'dozaldevs-opencode-setup'
    $req.Headers.Add('Authorization', "Bearer $script:Key")
    $req.Timeout = if ($Json) { 90000 } else { 30000 }
    if ($Json) {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Json)
        $req.ContentType = 'application/json'
        $req.ContentLength = $bytes.Length
        $stream = $req.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
    }
    $res = $null
    try { $res = $req.GetResponse() }
    catch [System.Net.WebException] { $res = $_.Exception.Response }
    if ($null -eq $res) { return @{ Status = 0; Body = '' } }
    $reader = New-Object System.IO.StreamReader($res.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Close()
    $status = [int]$res.StatusCode
    $res.Close()
    return @{ Status = $status; Body = $body }
}

function Get-RelayMessage([string]$Body) {
    if ($Body -match '"message"\s*:\s*"([^"]*)"') { return $Matches[1] }
    return ''
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @{ Raw = $null; Obj = (New-Object psobject) } }
    $raw = [System.IO.File]::ReadAllText($Path)
    if ($raw.Trim() -eq '') { return @{ Raw = $raw; Obj = (New-Object psobject) } }
    $obj = $null
    try { $obj = $raw | ConvertFrom-Json } catch { Die "$Path is not plain JSON (it may have comments in it), so I did not touch it. Ask the engineering team for help." }
    if ($null -eq $obj -or $obj -isnot [System.Management.Automation.PSCustomObject]) {
        Die "$Path is not plain JSON (it may have comments in it), so I did not touch it. Ask the engineering team for help."
    }
    return @{ Raw = $raw; Obj = $obj }
}

function Set-Prop($Object, [string]$Name, $Value) {
    if ($Object.PSObject.Properties.Match($Name).Count -gt 0) { $Object.$Name = $Value }
    else { Add-Member -InputObject $Object -NotePropertyName $Name -NotePropertyValue $Value }
}

function Get-PrettyName([string]$Id) {
    $parts = $Id.Split('-')
    $head = ($parts[0..([Math]::Min(1, $parts.Length - 1))] -join '-').ToUpper()
    $rest = @()
    if ($parts.Length -gt 2) { $rest = $parts[2..($parts.Length - 1)] | ForEach-Object { $_.Substring(0, 1).ToUpper() + $_.Substring(1) } }
    return (@($head) + $rest) -join ' '
}

function Save-JsonFile([string]$Path, $Loaded, [string]$Backup, $Object) {
    $text = ($Object | ConvertTo-Json -Depth 32) + "`n"
    if ($Loaded.Raw -ceq $text) { return 'unchanged' }
    if ($null -ne $Loaded.Raw) { [System.IO.File]::WriteAllText($Backup, $Loaded.Raw, $Utf8NoBom) }
    [System.IO.File]::WriteAllText($Path, $text, $Utf8NoBom)
    if ($null -eq $Loaded.Raw) { return 'created' }
    return 'updated'
}

function Update-Config([string[]]$Allowed, [string[]]$Usable, [hashtable]$Names) {
    $loaded = Read-JsonFile $ConfigFile
    $cfg = $loaded.Obj
    $models = New-Object psobject
    foreach ($m in $Allowed) { $label = if ($Names.ContainsKey($m)) { $Names[$m] } else { Get-PrettyName $m }; Add-Member -InputObject $models -NotePropertyName $m -NotePropertyValue ([pscustomobject]@{ name = $label }) }
    $provider = [pscustomobject][ordered]@{
        npm     = '@ai-sdk/openai-compatible'
        name    = $ProviderName
        options = [pscustomobject][ordered]@{ baseURL = "$RelayUrl/v1"; apiKey = "{file:$KeyFileForJson}" }
        models  = $models
    }
    $existing = $cfg.PSObject.Properties.Match('provider')
    if ($existing.Count -eq 0 -or $existing[0].Value -isnot [System.Management.Automation.PSCustomObject]) { Set-Prop $cfg 'provider' (New-Object psobject) }
    Set-Prop $cfg.provider $ProviderId $provider

    $pm = New-Object psobject
    foreach ($m in $Allowed) { $label = if ($Names.ContainsKey($m)) { $Names[$m] } else { Get-PrettyName $m }; Add-Member -InputObject $pm -NotePropertyName $m -NotePropertyValue ([pscustomobject][ordered]@{ name = $label; family = $m; releaseDate = $ReleaseDate }) }
    $existingProviders = $cfg.PSObject.Properties.Match('providers')
    if ($existingProviders.Count -eq 0 -or $existingProviders[0].Value -isnot [System.Management.Automation.PSCustomObject]) { Set-Prop $cfg 'providers' (New-Object psobject) }
    Set-Prop $cfg.providers $ProviderId ([pscustomobject][ordered]@{ name = $ProviderName; package = '@opencode/ai/providers/openai-compatible'; settings = ([pscustomobject][ordered]@{ baseURL = "$RelayUrl/v1"; apiKey = "{file:$KeyFileForJson}" }); models = $pm })

    $notes = @()
    $current = ''
    $m0 = $cfg.PSObject.Properties.Match('model')
    if ($m0.Count -gt 0 -and $m0[0].Value -is [string]) { $current = $m0[0].Value }
    $ours = $current.StartsWith("$ProviderId/")
    if ($current -eq '' -or ($ours -and ($Usable -notcontains $current.Substring($ProviderId.Length + 1)))) { Set-Prop $cfg 'model' "$ProviderId/$($Usable[0])" }
    elseif (-not $ours) { $notes += 'kept-model' }

    $ep = $cfg.PSObject.Properties.Match('enabled_providers')
    if ($ep.Count -gt 0 -and $ep[0].Value -is [array] -and ($ep[0].Value -notcontains $ProviderId)) { $cfg.enabled_providers = @($ep[0].Value) + $ProviderId }
    $dp = $cfg.PSObject.Properties.Match('disabled_providers')
    if ($dp.Count -gt 0 -and $dp[0].Value -is [array] -and ($dp[0].Value -contains $ProviderId)) { $cfg.disabled_providers = @($dp[0].Value | Where-Object { $_ -ne $ProviderId }) }

    if ($cfg.PSObject.Properties.Match('$schema').Count -eq 0) {
        $ordered = [ordered]@{ '$schema' = 'https://opencode.ai/config.json' }
        foreach ($p in $cfg.PSObject.Properties) { $ordered[$p.Name] = $p.Value }
        $cfg = [pscustomobject]$ordered
    }
    $result = Save-JsonFile $ConfigFile $loaded "$ConfigFile.bak-$Stamp" $cfg
    return (@($result) + $notes) -join ' '
}

function Main {
    # ---- 1. Get the key (typed into a hidden prompt; never on a command line) ----
    $script:Key = ''
    if ($Check) {
        if (-not (Test-Path -LiteralPath $KeyFile)) { Die "no saved key at $KeyFile. Run the setup first (without -Check)." }
        $script:Key = [System.IO.File]::ReadAllText($KeyFile)
    }
    elseif ($env:RELAY_API_KEY) { $script:Key = $env:RELAY_API_KEY }
    else {
        try { $secure = Read-Host 'Paste your relay API key (nothing shows as you type), then press Enter' -AsSecureString }
        catch { Die 'no way to ask for your key here. Run this in a PowerShell window, or set RELAY_API_KEY.' }
        $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $script:Key = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    $script:Key = $script:Key -replace '\s', ''
    if ($script:Key -eq '') { Die 'no key entered.' }
    if ($script:Key.Length -lt 16) { Die 'that does not look like a full key (too short). Copy the whole thing.' }

    # ---- 2. Make sure we can safely edit the settings file before talking to the relay ----
    if (-not $Check) { $null = Read-JsonFile $ConfigFile }

    # ---- 3. Check the key works ----
    Say 'Checking your key with the relay...'
    $r = Invoke-Relay 'GET' '/v1/models' ''
    switch ($r.Status) {
        200 { Ok 'The relay accepted your key.' }
        0 { Die "could not reach $RelayUrl. Check your internet connection and try again." }
        { $_ -in 401, 403 } { Die "the relay rejected your key ($(Get-RelayMessage $r.Body)). Ask the engineering team for a new one, and make sure you copied all of it." }
        default { Die "the relay answered with an unexpected error (HTTP $($r.Status)). Try again in a minute." }
    }

    # ---- 4. Find out which models this key may use ----
    # The relay knows: it lists what this key can use now, then models that need a request, marked as such.
    Say 'Finding the models your key can use...'
    $allowed = @()
    $listed = @()
    $names = @{}
    $r = Invoke-Relay 'GET' '/setup/models' ''
    if ($r.Status -eq 200) {
        foreach ($line in ($r.Body -split "`n")) {
            $parts = $line.TrimEnd("`r").Split("`t", 3)
            if ($parts.Length -lt 3 -or -not $parts[0]) { continue }
            $names[$parts[0]] = $parts[2]
            if ($parts[1] -eq 'allowed') { $allowed += $parts[0]; $listed += $parts[0]; Ok $parts[0] }
            elseif ($parts[1] -eq 'on_request') { $listed += $parts[0]; Say "     $($parts[0]): on request (ask the engineering team for temporary access)" }
        }
    }
    else {
        # An older relay without /setup/models: find the usable models by trying each one.
        if ($r.Status -eq 0) { Die 'lost the connection to the relay while listing models. Try again.' }
        if ($r.Status -in 401, 403) { Die "the relay rejected your key ($(Get-RelayMessage $r.Body))." }
        foreach ($model in $Candidates) {
            $payload = '{"model":"' + $model + '","messages":[{"role":"user","content":"Reply with exactly: ok"}]}'
            $r = Invoke-Relay 'POST' '/v1/chat/completions' $payload
            if ($r.Status -eq 200) { $allowed += $model; $listed += $model; Ok $model }
            elseif ($r.Status -eq 429) { $allowed += $model; $listed += $model; Warn "${model}: your daily limit is used up for today; it will work again after midnight UTC." }
            elseif ($r.Status -eq 403) { Say "     ${model}: not enabled for your key (skipped)" }
            elseif ($r.Status -eq 0) { Die 'lost the connection to the relay while testing models. Try again.' }
            else { Say "     ${model}: not available right now (skipped)" }
        }
    }
    if ($allowed.Count -eq 0) { Die 'your key is not allowed to use any model yet. Ask the engineering team to enable one.' }
    $allowedText = $allowed -join ' '

    # ---- Check mode stops here: confirm the settings point at the key, change nothing ----
    if ($Check) {
        if (-not (Test-Path -LiteralPath $ConfigFile)) { Die "no OpenCode settings at $ConfigFile. Run the setup first (without -Check)." }
        $text = [System.IO.File]::ReadAllText($ConfigFile)
        if (-not $text.Contains("`"$ProviderId`"")) { Die 'OpenCode is not set up for the relay yet. Run the setup first (without -Check).' }
        if (-not $text.Contains("{file:$KeyFileForJson}")) { Die "OpenCode's settings do not point at your saved key. Run the setup again (without -Check)." }
        Ok "OpenCode's settings point at your saved key."
        $loaded = Read-JsonFile $ConfigFile
        $rec = $null
        $pp = $loaded.Obj.PSObject.Properties.Match('providers')
        if ($pp.Count -gt 0 -and $pp[0].Value -is [System.Management.Automation.PSCustomObject]) { $rp = $pp[0].Value.PSObject.Properties.Match($ProviderId); if ($rp.Count -gt 0) { $rec = $rp[0].Value } }
        $date = $null
        if ($null -ne $rec -and $null -ne $rec.models) { foreach ($mp in $rec.models.PSObject.Properties) { if ($mp.Value.releaseDate) { $date = $mp.Value.releaseDate; break } } }
        if (-not $date) { Die "OpenCode's model menu entries are out of date. Run the setup again (without -Check)." }
        $age = ([datetime]::Parse($ReleaseDate, [Globalization.CultureInfo]::InvariantCulture) - [datetime]::Parse($date, [Globalization.CultureInfo]::InvariantCulture)).Days
        if ($age -gt $StaleDays) { Die "the relay's models will drop out of OpenCode's model menu soon (set up $age days ago). Run the setup again (without -Check) to refresh them." }
        Ok "The relay's models are set to show in OpenCode's model menu."
        Say ''
        Say "Check passed. Models you can use: $allowedText"
        return
    }

    # ---- 5. Save the key (private file) and write the settings ----
    $null = New-Item -ItemType Directory -Force -Path (Split-Path $ConfigFile), (Split-Path $KeyFile)
    $keyResult = 'created'
    if (Test-Path -LiteralPath $KeyFile) {
        if ([System.IO.File]::ReadAllText($KeyFile) -ceq $script:Key) { $keyResult = 'unchanged' } else { $keyResult = 'updated' }
    }
    if ($keyResult -ne 'unchanged') { [System.IO.File]::WriteAllText($KeyFile, $script:Key, $Utf8NoBom) }
    try {
        if ($env:OS -eq 'Windows_NT') { $null = & icacls.exe $KeyFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1 }
        else { $null = & chmod 600 $KeyFile 2>&1 }
    } catch {}

    $configResult = Update-Config $listed $allowed $names
    Ok "OpenCode settings: $($configResult.Split(' ')[0]) ($ConfigFile)"
    Ok "Your key: $keyResult (private file $KeyFile)"
    if ($configResult -like '*kept-model*') { Say "     Your existing default model was left as it was; pick the relay's models from the model menu." }

    # ---- 6. Tell them what to do next ----
    Say ''
    Say "All set. Models you can use: $allowedText"
    $onRequest = @($listed | Where-Object { $allowed -notcontains $_ })
    if ($onRequest.Count -gt 0) { Say ('Listed as "on request" (ask the engineering team for temporary access): ' + ($onRequest -join ' ')) }
    Say "Default model: $ProviderId/$($allowed[0])"
    Say ''
    $running = $false
    try { $running = [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'OpenCode*' }) } catch {}
    if ($running) { Say 'OpenCode is open right now. Close it completely and open it again to pick up the change.' }
    else { Say 'Open OpenCode and start chatting. It is already connected.' }
    Say 'To double-check later, run the same command again with -Check on the end. If something does not work, send the engineering team what it prints (it never prints your key).'
}

try { Main }
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($PSCommandPath) { exit 1 }
}
