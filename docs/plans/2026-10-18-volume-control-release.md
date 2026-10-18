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
