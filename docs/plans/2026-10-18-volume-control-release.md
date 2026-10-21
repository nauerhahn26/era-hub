# Per-device speaker limit patch release

Settings now offers On, Off and an adjustable maximum speaker percentage for
this device (0–100, default 45). Lower and higher caps are both supported.
The mode and percentage persist in the local engine configuration; changing
one device does not affect another device or the shared music setting.
Raising the cap does not raise current volume. New devices retain opt-in behavior.

The engine's unified `/volcap` request accepts `deviceEnabled` and `deviceCap`.
On an explicit save it neutralizes the old watchdog ceiling by persisting
`CAP=100` and stops only the known watchdog executable. Its scheduled task can
restart harmlessly without restoring the old ceiling or undoing Off. Existing
clients keep the legacy and integrated endpoint contracts. Settings checks the
returned state before reporting success, and hides the control on old engines.

Validation required before publication: Settings handler and browser suites,
Windows engine volume regression (real legacy watchdog, increase/decrease,
Off and fresh-process persistence, task restart, bad input and failed writes),
full cross-repository gate, then Windows patch self-update on the exact archive.

Target: v1.0.4, retaining the existing v1.0.0 signed installer. Publication and
Windows validation receipts will be recorded here after release finishes.

## Published receipt

- Released [v1.0.4](https://github.com/nauerhahn26/new-era-releases/releases/tag/v1.0.4),
  build `20261018.1738`, retaining the verified signed v1.0.0 installer.
- Landed and pushed: gaze `fc73172`, hub `552d44a`. Feature commits:
  gaze `3ec5162`, hub `ea9b048` (plus the initial Settings commit `3a7f7eb`).
- Full cross-repository gate: **123 suites passed, zero failed**, with
  `ERA_WT_SUFFIX=--wt-volume-control` selecting the matching engine worktree.
- Settings handler tests and the browser test cover raising above 45, lowering,
  On/Off, reopening Settings, invalid input and failed/unconfirmed writes.
- Windows volume regression passed against the committed engine and a real
  standalone watchdog in a sandbox: default 45, legacy takeover, increases and
  decreases, Off surviving a fresh process, scheduled watchdog restart, bad
  input and persistence failure. Command: gaze `tests/volume-cap-regression.ps1`.
- Release Windows self-update leg B: **5 passed, zero failed** on the exact
  published archive. Clean install, wizard, live update with the kiosk retained,
  preferences/app preservation and clean shutdown all passed.
- Archive SHA256:
  `440d30fcf05182fb473b330bae496c906402a80ecbbb6d75169a0ffe20e83eeb`.
- Public latest feed reports v1.0.4. Its archive was downloaded and verified
  against the feed checksum and the committed Settings/engine source bytes.
  All six release assets are uploaded; release notes describe the controls.
- Packaged engine SHA256:
  `c17b19c080338a909fbf50271a9123e9c80fdaeed81d69b9c48d40c3a37534d7`.
- The disposable QA host used the documented temporary baseline/account repair.
  Its Windows servicing wait completed normally. The host was destroyed after
  publication; `qa.sh status` confirms none running. The permanent template
  was not changed.

Release command:

```
ERA_WT_SUFFIX=--wt-volume-control VM_OUT=/tmp/volume-release-20261018/vm bash tools/release.sh v1.0.4 --patch --skip-gate
```

The skip used the clean matching 123/0 gate stamp; it did not skip the build
or Windows test. Installed devices receive the patch through normal automatic
updates. Publication is verified; installation on family devices is unverified.
