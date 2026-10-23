$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-SliccCapture([object[]]$Arguments) {
  $name = 'slicc-capture'
  $bin = 'sccapture'
  $repo = 'ai-ecoverse/slicc-capture'
  $minNode = 24
  $npm = 'npm install -g @ai-ecoverse/slicc-capture'

  $version = "$env:VERSION"
  $dir = "$env:INSTALL_DIR"
  $releases = "$env:SLICC_INSTALL_BASE_URL"
  if (-not $releases) { $releases = "https://github.com/$repo/releases" }
  $nodeDist = "$env:SLICC_NODE_DIST_BASE"
  if (-not $nodeDist) { $nodeDist = 'https://nodejs.org/dist' }

  $rest = @()
  if ($Arguments) { $rest = @($Arguments) }
  for ($i = 0; $i -lt $rest.Count; $i++) {
    $arg = "$($rest[$i])"
    switch -CaseSensitive ($arg) {
      '--help' {
        [Console]::Out.WriteLine("usage: install.ps1 [--version <version>] [--dir <dir>] [--help]`n")
        [Console]::Out.WriteLine("Installs $bin, from the latest release of $repo or <version>, with Node $minNode or later (downloaded if missing).`n")
        [Console]::Out.WriteLine('  --version <version>  the release to install (default: the latest; or VERSION)')
        [Console]::Out.WriteLine('  --dir <dir>          where the launcher goes (default: %LOCALAPPDATA%\slicc-capture\bin; or INSTALL_DIR)')
        [Console]::Out.WriteLine('  --help               print this and exit')
        return
      }
      { $_ -eq '--version' -or $_ -eq '--dir' } {
        if ($i + 1 -ge $rest.Count -or "$($rest[$i + 1])" -eq '') { throw "$arg needs a value" }
        $i++
        if ($arg -eq '--version') { $version = "$($rest[$i])" } else { $dir = "$($rest[$i])" }
      }
      default { throw "unknown option: $arg" }
    }
  }

  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set' }
  $data = Join-Path $env:LOCALAPPDATA $name
  if (-not $dir) { $dir = Join-Path $data 'bin' }
  if ($version.StartsWith('v')) { $version = $version.Substring(1) }
  if ($version -and $version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$') {
    throw "invalid version: $version"
  }

  $onWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("$name-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $stage = $null
  try {
    function Get-Download([string]$url, [string]$out) {
      try {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
      } catch {
        throw "download failed: $url"
      }
    }

    function Assert-Checksum([string]$file, [string]$label, [string]$expected) {
      if (-not $expected) { throw "no checksum for $label" }
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
      if ($actual -cne $expected.ToLowerInvariant()) { throw "checksum mismatch for $label" }
    }

    function Find-Sum([string]$sums, [string]$file) {
      foreach ($line in [IO.File]::ReadAllLines($sums)) {
        if ($line -match '^([0-9a-fA-F]{64}) [ *](.+)$' -and $Matches[2] -ceq $file) { return $Matches[1] }
      }
      return $null
    }

    function Test-Node([string]$node) {
      if (-not $node -or -not (Test-Path -LiteralPath $node)) { return $false }
      try { $out = "$(& $node --version 2>$null)" } catch { return $false }
      if ($out -match '^v?([0-9]+)\.') { return [int]$Matches[1] -ge $minNode }
      return $false
    }

    $managed = Join-Path (Join-Path $data 'node') 'node.exe'
    $node = $null
    $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found -and (Test-Node $found.Source)) {
      $node = $found.Source
    } elseif (Test-Node $managed) {
      $node = $managed
    } else {
      if (-not $onWindows) { throw "unsupported OS: install.ps1 is for Windows; use install.sh or $npm" }
      $cpu = "$env:PROCESSOR_ARCHITEW6432"
      if (-not $cpu) { $cpu = "$env:PROCESSOR_ARCHITECTURE" }
      switch ($cpu) {
        'AMD64' { $arch = 'x64' }
        'ARM64' { $arch = 'arm64' }
        default { throw "unsupported architecture: $cpu; install Node $minNode or later, or use $npm" }
      }
      Get-Download "$nodeDist/index.json" (Join-Path $tmp 'index.json')
      $lts = $null
      foreach ($entry in (Get-Content -Raw -LiteralPath (Join-Path $tmp 'index.json') | ConvertFrom-Json)) {
        if ($entry.lts -and "$($entry.version)" -match '^v([0-9]+)\.[0-9]+\.[0-9]+$' -and [int]$Matches[1] -ge $minNode) {
          $lts = "$($entry.version)".Substring(1)
          break
        }
      }
      if (-not $lts) { throw "no Node LTS release $minNode or later in $nodeDist/index.json" }
      $base = "node-v$lts-win-$arch"
      $zip = Join-Path $tmp "$base.zip"
      Get-Download "$nodeDist/v$lts/SHASUMS256.txt" (Join-Path $tmp 'SHASUMS256.txt')
      [Console]::Error.WriteLine("${name}: downloading Node $lts")
      Get-Download "$nodeDist/v$lts/$base.zip" $zip
      Assert-Checksum $zip "$base.zip" (Find-Sum (Join-Path $tmp 'SHASUMS256.txt') "$base.zip")
      New-Item -ItemType Directory -Path $data -Force | Out-Null
      $stage = Join-Path $data ".node-$PID"
      if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
      Expand-Archive -LiteralPath $zip -DestinationPath $stage
      $unpacked = Join-Path $stage $base
      if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'node.exe'))) { throw "no node.exe in $base.zip" }
      $target = Join-Path $data 'node'
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath $unpacked -Destination $target
      Remove-Item -LiteralPath $stage -Recurse -Force
      $stage = $null
      $node = $managed
    }
    if (-not (Test-Node $node)) { throw "$node is not Node $minNode or later" }

    if ($version) { $base = "$releases/download/v$version" } else { $base = "$releases/latest/download" }
    $sums = Join-Path $tmp 'SHA256SUMS'
    Get-Download "$base/SHA256SUMS" $sums
    if (-not $version) {
      foreach ($line in [IO.File]::ReadAllLines($sums)) {
        if ($line -cmatch "^[0-9a-f]{64} [ *]$name-([0-9][0-9A-Za-z.+-]*)\.tgz$") {
          $version = $Matches[1]
          break
        }
      }
      if (-not $version) { throw "no $name tarball in $base/SHA256SUMS" }
    }
    $tarball = "$name-$version.tgz"
    $sum = Find-Sum $sums $tarball
    if (-not $sum) { throw "no checksum for $tarball in $base/SHA256SUMS" }
    $file = Join-Path $tmp $tarball
    Get-Download "$base/$tarball" $file
    Assert-Checksum $file $tarball $sum

    $tar = Get-Command tar -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $tar) { throw 'tar is required (Windows 10 1803 or later has it)' }
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $stage = Join-Path $data ".install-$PID"
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    & $tar.Source -xzf $file -C $stage --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw "could not unpack $tarball" }
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $stage 'host') "$bin.mjs"))) { throw "no host/$bin.mjs in $tarball" }
    $current = Join-Path $data 'current'
    $link = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($link) { $link.Delete() }
    $versionDir = Join-Path $data $version
    if (Test-Path -LiteralPath $versionDir) { Remove-Item -LiteralPath $versionDir -Recurse -Force }
    Move-Item -LiteralPath $stage -Destination $versionDir
    $stage = $null

    if ($onWindows) {
      New-Item -ItemType Junction -Path $current -Target $versionDir | Out-Null
    } else {
      New-Item -ItemType SymbolicLink -Path $current -Target $versionDir | Out-Null
    }

    $entry = Join-Path (Join-Path $versionDir 'host') "$bin.mjs"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $dir = (Resolve-Path -LiteralPath $dir).ProviderPath
    $launcher = Join-Path $dir "$bin.cmd"
    $line = '@"' + $node.Replace('%', '%%') + '" "' + $entry.Replace('%', '%%') + '" %*'
    try {
      $encoding = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    } catch {
      $encoding = New-Object Text.UTF8Encoding $false
    }
    [IO.File]::WriteAllText("$launcher.$PID", "$line`r`n", $encoding)
    Move-Item -LiteralPath "$launcher.$PID" -Destination $launcher -Force

    $installed = "$(& $node $entry --version 2>$null)".Trim()
    if ($LASTEXITCODE -ne 0 -or -not $installed) { throw "$launcher --version failed" }
    [Console]::Out.WriteLine("$bin $installed installed to $launcher")

    $sep = [IO.Path]::PathSeparator
    $paths = @("$env:PATH".Split($sep)) + @("$([Environment]::GetEnvironmentVariable('Path', 'User'))".Split($sep))
    $on = $false
    foreach ($p in $paths) {
      if ($p -and $p.TrimEnd('\', '/') -eq $dir.TrimEnd('\', '/')) { $on = $true }
    }
    if (-not $on) {
      [Console]::Out.WriteLine("$dir is not on PATH; add it with: [Environment]::SetEnvironmentVariable('Path', '$($dir.Replace("'", "''"));' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')")
    }
  } finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$code = 0
try {
  Install-SliccCapture -Arguments $args
} catch {
  [Console]::Error.WriteLine("slicc-capture: $($_.Exception.Message)")
  $code = 1
}
if ($MyInvocation.MyCommand.Path) { exit $code }
if ($code -ne 0) { $global:LASTEXITCODE = $code }
