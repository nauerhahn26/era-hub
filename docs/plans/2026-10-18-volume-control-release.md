# Per-device speaker limit patch release

The Settings volume card previously exposed only the legacy speaker watchdog's
on/off switch. It now offers a maximum speaker percentage using the existing
local engine's integrated volume-cap API. This lets a device use a lower limit
than its legacy watchdog ceiling without changing another device or the shared
music setting.

The saved percentage enables the integrated cap and persists through the
engine's device configuration. Settings verifies the returned enabled state and
percentage before reporting success. The separate watchdog remains active and
its ceiling is shown. Raising the saved cap does not raise current volume.

Validation before release: three focused handler tests pass, covering local
writes, invalid input, failed saves, legacy limits and unavailable engines.
The Settings browser suite passes all 69 tests. Full gate and Windows patch
self-update validation are required before publication.

Target: v1.0.4, patch over the existing v1.0.0 signed installer. Publication and
Windows validation receipts will be recorded here after the release finishes.
