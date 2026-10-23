param(
  [string]$Version = '',
  [string]$Dir = '',
  [switch]$Help
)

try {
  & {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    $BinName = 'sccapture'
    $Package = 'slicc-capture'
    $Repo = 'ai-ecoverse/slicc-capture'
    $MinNode = 24
    $OnWindows = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
    $LocalData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [System.Environment]::GetFolderPath('LocalApplicationData') }
    $DataDir = Join-Path $LocalData $Package
    $NodeDist = if ($env:SLICC_NODE_DIST_BASE) { $env:SLICC_NODE_DIST_BASE.TrimEnd('/') } else { 'https://nodejs.org/dist' }

    function Show-Usage {
      Write-Output 'usage: install.ps1 [-Version VERSION] [-Dir DIR] [-Help]'
      Write-Output ''
      Write-Output "Installs $BinName from @ai-ecoverse/$Package, with Node $MinNode or later (downloaded if missing)."
      Write-Output ''
      Write-Output '  -Version VERSION   the release to install (default: the latest)'
      Write-Output "  -Dir DIR           where the launcher goes (default: $DataDir\bin, added to the user's PATH)"
      Write-Output '  -Help              print this usage and exit'
    }

    function Stop-Install([string]$Message) {
      throw "install.ps1: $Message"
    }

    function Get-File([string]$Url, [string]$Path) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
      } catch {
        Stop-Install "could not download ${Url}: $($_.Exception.Message)"
      }
    }

    function Get-Sum([string]$Sums, [string]$Name) {
      foreach ($line in Get-Content -LiteralPath $Sums) {
        if ($line -match '^([0-9a-f]{64})  \*?(.+)$' -and $Matches[2] -eq $Name) { return $Matches[1] }
      }
      return ''
    }

    function Test-Sum([string]$Path, [string]$Expected) {
      $name = Split-Path -Leaf $Path
      if (-not $Expected) { Stop-Install "no checksum for $name" }
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
      if ($actual -ne $Expected) { Stop-Install "checksum mismatch for ${name}: expected $Expected, got $actual" }
    }

    function Test-Node([string]$Path) {
      try {
        $reported = & $Path --version 2>$null
      } catch {
        return $false
      }
      if ($LASTEXITCODE -ne 0 -or -not ("$reported" -match '^v(\d+)\.')) { return $false }
      return [int]$Matches[1] -ge $MinNode
    }

    function Get-Node {
      $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($onPath -and (Test-Node $onPath.Source)) { return $onPath.Source }
      $managed = Join-Path (Join-Path $DataDir 'node') 'node.exe'
      if ((Test-Path -LiteralPath $managed) -and (Test-Node $managed)) { return $managed }
      if (-not $OnWindows) { Stop-Install "no Node $MinNode or later on PATH; install it and re-run" }
      $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { Stop-Install "no Node download for $($env:PROCESSOR_ARCHITECTURE); install Node $MinNode or later and re-run" }
      }
      [Console]::Error.WriteLine("install.ps1: no Node $MinNode or later on PATH, downloading it")
      $index = Invoke-RestMethod -UseBasicParsing -Uri "$NodeDist/index.json"
      $candidates = @($index | Where-Object { [int]($_.version -replace '^v(\d+)\..*$', '$1') -ge $MinNode })
      $pick = $candidates | Where-Object { $_.lts } | Select-Object -First 1
      if (-not $pick) { $pick = $candidates | Select-Object -First 1 }
      if (-not $pick) { Stop-Install "no Node $MinNode or later in $NodeDist/index.json" }
      $nodeVersion = $pick.version
      $archive = "node-$nodeVersion-win-$arch.zip"
      $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sccapture-node-" + [System.Guid]::NewGuid())
      New-Item -ItemType Directory -Path $tmp | Out-Null
      try {
        Get-File "$NodeDist/$nodeVersion/SHASUMS256.txt" (Join-Path $tmp 'SHASUMS256.txt')
        Get-File "$NodeDist/$nodeVersion/$archive" (Join-Path $tmp $archive)
        Test-Sum (Join-Path $tmp $archive) (Get-Sum (Join-Path $tmp 'SHASUMS256.txt') $archive)
        Expand-Archive -LiteralPath (Join-Path $tmp $archive) -DestinationPath $tmp
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        $nodeDir = Join-Path $DataDir 'node'
        if (Test-Path -LiteralPath $nodeDir) { Remove-Item -Recurse -Force -LiteralPath $nodeDir }
        Move-Item -LiteralPath (Join-Path $tmp "node-$nodeVersion-win-$arch") -Destination $nodeDir
      } finally {
        Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
      }
      [Console]::Error.WriteLine("install.ps1: Node $nodeVersion installed to $nodeDir")
      return $managed
    }

    function Get-Quoted([string]$Text) {
      return "'" + $Text.Replace("'", "''") + "'"
    }

    if ($Help) {
      Show-Usage
      return
    }

    $Version = $Version -replace '^v', ''
    if (-not $Dir) { $Dir = Join-Path $DataDir 'bin' }

    $Node = Get-Node

    $Base = if ($env:SLICC_INSTALL_BASE_URL) {
      $env:SLICC_INSTALL_BASE_URL.TrimEnd('/')
    } elseif ($Version) {
      "https://github.com/$Repo/releases/download/v$Version"
    } else {
      "https://github.com/$Repo/releases/latest/download"
    }

    $Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("sccapture-install-" + [System.Guid]::NewGuid())
    New-Item -ItemType Directory -Path $Tmp | Out-Null
    $Extract = $null
    try {
      $Sums = Join-Path $Tmp 'SHA256SUMS'
      Get-File "$Base/SHA256SUMS" $Sums
      if ($Version) {
        $Tgz = "$Package-$Version.tgz"
      } else {
        $Tgz = ''
        foreach ($line in Get-Content -LiteralPath $Sums) {
          if ($line -match "^[0-9a-f]{64}  \*?($Package-[0-9][0-9A-Za-z.+-]*\.tgz)$") {
            $Tgz = $Matches[1]
            break
          }
        }
        if (-not $Tgz) { Stop-Install "no $Package tarball in $Base/SHA256SUMS" }
      }
      $Tarball = Join-Path $Tmp $Tgz
      Get-File "$Base/$Tgz" $Tarball
      Test-Sum $Tarball (Get-Sum $Sums $Tgz)

      $BundleVersion = $Tgz.Substring($Package.Length + 1, $Tgz.Length - $Package.Length - 5)
      $BundleDir = Join-Path $DataDir $BundleVersion
      $Extract = Join-Path $DataDir (".bundle-" + [System.Guid]::NewGuid())
      New-Item -ItemType Directory -Force -Path $Extract | Out-Null
      $tar = if ($OnWindows) { Join-Path $env:SystemRoot 'System32\tar.exe' } else { 'tar' }
      & $tar -xzf $Tarball -C $Extract --strip-components=1
      if ($LASTEXITCODE -ne 0) { Stop-Install "could not unpack $Tgz" }
      $Entry = Join-Path (Join-Path $BundleDir 'host') "$BinName.mjs"
      if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $Extract 'host') "$BinName.mjs"))) {
        Stop-Install "$Tgz has no host/$BinName.mjs"
      }
      & $Node -e 'const f = process.argv[1]; const p = JSON.parse(require(`fs`).readFileSync(f, `utf8`)); if (Object.keys({ ...p.dependencies, ...p.optionalDependencies }).length === 0) process.exit(1); delete p.devDependencies; require(`fs`).writeFileSync(f, JSON.stringify(p, null, 2))' (Join-Path $Extract 'package.json')
      if ($LASTEXITCODE -eq 0) {
        $nodeDir = Split-Path -Parent $Node
        $npmCli = @(
          (Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js'),
          (Join-Path $nodeDir '../lib/node_modules/npm/bin/npm-cli.js')
        ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $npmCli) { Stop-Install "$Tgz has dependencies, and there is no npm next to $Node" }
        Push-Location -LiteralPath $Extract
        try {
          & $Node $npmCli install --omit=dev --ignore-scripts --no-audit --no-fund | ForEach-Object { [Console]::Error.WriteLine($_) }
          $npmStatus = $LASTEXITCODE
        } finally {
          Pop-Location
        }
        if ($npmStatus -ne 0) { Stop-Install "npm install failed for $Tgz" }
      }
      if (Test-Path -LiteralPath $BundleDir) { Remove-Item -Recurse -Force -LiteralPath $BundleDir }
      Move-Item -LiteralPath $Extract -Destination $BundleDir
    } finally {
      Remove-Item -Recurse -Force -LiteralPath $Tmp -ErrorAction SilentlyContinue
      if ($Extract -and (Test-Path -LiteralPath $Extract)) { Remove-Item -Recurse -Force -LiteralPath $Extract -ErrorAction SilentlyContinue }
    }

    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $Dir = (Resolve-Path -LiteralPath $Dir).ProviderPath
    $Launcher = Join-Path $Dir "$BinName.ps1"
    $Cmd = Join-Path $Dir "$BinName.cmd"

    $ps1 = @(
      '$sccapturePrevious = $env:SCCAPTURE_INSTALL_DIR',
      "`$env:SCCAPTURE_INSTALL_DIR = $(Get-Quoted $Dir)",
      '$sccaptureProxy = $env:NODE_USE_ENV_PROXY',
      'if ($null -eq $sccaptureProxy) { $env:NODE_USE_ENV_PROXY = ''1'' }',
      '$sccaptureMode = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue',
      '$sccaptureLegacy = $PSVersionTable.PSVersion.Major -lt 7 -or "$sccaptureMode" -eq ''Legacy'' -or ($null -eq $sccaptureMode -and $PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion.Minor -lt 3)',
      '$sccaptureArgs = @(foreach ($sccaptureArg in $args) { foreach ($sccaptureItem in @($sccaptureArg)) {',
      '  $sccaptureText = "$sccaptureItem"',
      '  if (-not $sccaptureLegacy) { $sccaptureText }',
      '  elseif ($sccaptureText -eq '''') { ''""'' }',
      '  else {',
      '    $sccaptureText = $sccaptureText -replace ''(\\*)"'', ''$1$1\"''',
      '    if ($PSVersionTable.PSEdition -ne ''Core'' -and $sccaptureText -match ''\s'') { $sccaptureText -replace ''(\\+)$'', ''$1$1'' } else { $sccaptureText }',
      '  }',
      '} })',
      '$sccaptureStatus = 1',
      'try {',
      "  & $(Get-Quoted $Node) $(Get-Quoted $Entry) @sccaptureArgs",
      '  $sccaptureStatus = $LASTEXITCODE',
      '} finally {',
      '  if ($null -eq $sccapturePrevious) { Remove-Item -LiteralPath Env:SCCAPTURE_INSTALL_DIR -ErrorAction SilentlyContinue } else { $env:SCCAPTURE_INSTALL_DIR = $sccapturePrevious }',
      '  if ($null -eq $sccaptureProxy) { Remove-Item -LiteralPath Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue }',
      '}',
      'exit $sccaptureStatus',
      ''
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($Launcher, $ps1, (New-Object System.Text.UTF8Encoding $true))

    $escape = { param($Text) $Text.Replace('%', '%%') }
    $cmdLines = @(
      '@echo off',
      'setlocal',
      'for /f "tokens=2 delims=:." %%c in (''chcp'') do set "SCCAPTURE_CP=%%c"',
      'chcp 65001 >nul',
      "set `"SCCAPTURE_INSTALL_DIR=$(& $escape $Dir)`"",
      'if not defined NODE_USE_ENV_PROXY set "NODE_USE_ENV_PROXY=1"',
      "`"$(& $escape $Node)`" `"$(& $escape $Entry)`" %* & call :done %%ERRORLEVEL%% & call exit /b %%ERRORLEVEL%%",
      ':done',
      'chcp %SCCAPTURE_CP% >nul',
      'exit /b %1',
      ''
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($Cmd, $cmdLines, (New-Object System.Text.UTF8Encoding $false))

    $Reported = & $Node $Entry --version
    if ($LASTEXITCODE -ne 0 -or ("$Reported" -ne "$BundleVersion" -and "$Reported" -ne "$BinName $BundleVersion")) {
      Stop-Install "$Entry reports $Reported, not $BundleVersion"
    }
    Write-Output "$BinName $BundleVersion installed to $Launcher"

    if ($OnWindows) {
      $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
      $parts = @(if ($userPath) { $userPath.Split(';') | Where-Object { $_ } })
      if ($parts -notcontains $Dir) {
        [System.Environment]::SetEnvironmentVariable('Path', (@($parts) + $Dir) -join ';', 'User')
        Write-Output "Added $Dir to your user PATH; open a new terminal to use $BinName"
        Write-Output "To undo: [Environment]::SetEnvironmentVariable('Path', (([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') -ne $(Get-Quoted $Dir)) -join ';', 'User')"
      }
    }

    $policy = "$(Get-ExecutionPolicy)"
    if (@('Restricted', 'AllSigned', 'Undefined') -contains $policy) {
      [Console]::Error.WriteLine("install.ps1: the execution policy is $policy, so PowerShell won't run $BinName.ps1; run Set-ExecutionPolicy -Scope CurrentUser RemoteSigned, or use $BinName.cmd")
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  if ($MyInvocation.MyCommand.Path) { exit 1 }
}
