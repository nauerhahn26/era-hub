# smartscreen-facts.ps1 - everything about the downloaded file that can be read
# without a desktop, in one ssh round trip. Run BY ship.sh in the guest's ssh
# session (no window is needed here); the dialogs themselves are
# smartscreen-probe.ps1's job. ASCII only, PowerShell 5.1.
# Prints KEY=value lines; the leg parses them. No secrets, no PII.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$f = Join-Path $env:USERPROFILE 'Downloads\New-ERA-Setup.exe'
if (-not (Test-Path $f)) {
  $alt = Get-ChildItem (Join-Path $env:USERPROFILE 'Downloads') -Filter 'New-ERA-Setup*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($alt) { $f = $alt.FullName }
}
"FILE=" + $f
if (-not (Test-Path $f)) { "PRESENT=0"; "FACTS_DONE"; return }
"PRESENT=1"
"BYTES=" + (Get-Item $f).Length
"SHA256=" + (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()

# Mark-of-the-Web. It must have been written BY THE BROWSER: a HostUrl pointing
# at the release asset host is something only a real download produces. The 9/6
# check stamped the ADS by hand with Set-Content -Stream, which proves nothing
# about the path a family walks.
$z = Get-Content -Path $f -Stream Zone.Identifier -ErrorAction SilentlyContinue
if ($z) { "MOTW=" + (($z | Where-Object { $_ }) -join ' | ') } else { "MOTW=none" }

$sig = Get-AuthenticodeSignature $f
"SIG_STATUS=" + $sig.Status
"SIG_MESSAGE=" + $sig.StatusMessage
if ($sig.SignerCertificate) {
  "SIG_SUBJECT=" + $sig.SignerCertificate.Subject
  "SIG_ISSUER=" + $sig.SignerCertificate.Issuer
  "SIG_NOTAFTER=" + $sig.SignerCertificate.NotAfter.ToString('yyyy-MM-dd')
  "SIG_THUMBPRINT=" + $sig.SignerCertificate.Thumbprint
} else { "SIG_SUBJECT="; "SIG_ISSUER="; "SIG_NOTAFTER="; "SIG_THUMBPRINT=" }
if ($sig.TimeStamperCertificate) { "SIG_TIMESTAMPER=" + $sig.TimeStamperCertificate.Subject } else { "SIG_TIMESTAMPER=" }

# SmartScreen's own switches: a leg that runs on a guest with SmartScreen off
# would report "no interstitial" forever and mean nothing by it.
$exp = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' -Name SmartScreenEnabled -ErrorAction SilentlyContinue
"SS_EXPLORER=" + $(if ($exp) { $exp.SmartScreenEnabled } else { 'unset' })
$pol = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name EnableSmartScreen -ErrorAction SilentlyContinue
"SS_POLICY=" + $(if ($pol) { $pol.EnableSmartScreen } else { 'unset' })
$app = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AppHost' -Name EnableWebContentEvaluation -ErrorAction SilentlyContinue
"SS_APPHOST=" + $(if ($app) { $app.EnableWebContentEvaluation } else { 'unset' })
"SS_BINARY=" + (Test-Path "$env:SystemRoot\System32\smartscreen.exe")

$st = Get-MpComputerStatus -ErrorAction SilentlyContinue
if ($st) { "DEF_RTP=" + $st.RealTimeProtectionEnabled; "DEF_SIGS_AGE_DAYS=" + $st.AntivirusSignatureAge } else { "DEF_RTP=unknown" }
$pref = Get-MpPreference -ErrorAction SilentlyContinue
if ($pref) { "DEF_MAPS=" + $pref.MAPSReporting; "DEF_CLOUDBLOCK=" + $pref.CloudBlockLevel }
"DEF_THREATS=" + ((Get-MpThreatDetection -ErrorAction SilentlyContinue | Measure-Object).Count)
foreach ($t in (Get-MpThreat -ErrorAction SilentlyContinue)) { "DEF_THREAT_NAME=" + $t.ThreatName }
"FACTS_DONE"
