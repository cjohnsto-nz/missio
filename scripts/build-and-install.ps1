param(
  [string]$OutputPath,
  [string]$CodeCommand,
  [switch]$SkipNpmCi
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Host ""
  Write-Host "==> $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repoRoot

try {
  if ($SkipNpmCi) {
    if (-not (Test-Path -LiteralPath 'node_modules')) {
      throw 'node_modules was not found. Run without -SkipNpmCi to install dependencies before packaging.'
    }
    Write-Host ""
    Write-Host "==> Skipping dependency install"
  } else {
    Invoke-Checked 'Install dependencies' { npm ci }
  }

  $packageJson = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
  $version = [string]$packageJson.version

  if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $env:TEMP "missio-$version-local.vsix"
  }

  $resolvedOutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
  $outputDir = Split-Path -Parent $resolvedOutputPath
  if (-not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
  }
  if (Test-Path -LiteralPath $resolvedOutputPath) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force
  }

  if ([string]::IsNullOrWhiteSpace($CodeCommand)) {
    $code = Get-Command code.cmd -ErrorAction SilentlyContinue
    if (-not $code) {
      $code = Get-Command code -ErrorAction SilentlyContinue
    }
    if (-not $code) {
      throw 'Could not find VS Code CLI. Add code.cmd/code to PATH or pass -CodeCommand <path>.'
    }
    $CodeCommand = $code.Source
  }

  Invoke-Checked 'Package VSIX (runs npm run vscode:prepublish)' {
    npx @vscode/vsce package --out $resolvedOutputPath
  }

  Invoke-Checked 'Install VSIX into VS Code' {
    & $CodeCommand --install-extension $resolvedOutputPath --force
  }

  Write-Host ""
  Write-Host "==> Installed extension"
  & $CodeCommand --list-extensions --show-versions | Select-String -Pattern '^missio\.missio@'

  Write-Host ""
  Write-Host "VSIX: $resolvedOutputPath"
} finally {
  Pop-Location
}
