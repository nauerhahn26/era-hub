# Camera startup, playback icons and full-screen app launches

The maintainer requested automatic self-video after configuration, icon-based
playback commands with Play/Pause state, and app launches that cover the Windows
taskbar without a hand touch. Testing and deployment are authorized.

## Camera and controls

Speech Mirror stores its successful camera setup and selected camera identifier
and label in this device's local Hub data, using `slp-videos/camera.json` and
the loopback-only `GET`/`PUT /api/slp-videos/camera` endpoint. Edge's kiosk mode
uses InPrivate sessions, so browser storage cannot be the durable source. If
the browser rotates identifiers, only a uniquely matching saved camera label
can rebind that selection; a missing or ambiguous camera requires the partner.
Later app
launches restore that camera preview when visible and unlocked. Camera failure
is shown with recovery instructions; it never starts the microphone. Explicit
Stop camera opts out of automatic preview until the partner starts it again.
Lifecycle suspension preserves the preference but releases tracks. A late
permission grant after leaving must release its tracks without saving a new
successful configuration. Recording continues to require an explicit action.
If a pending camera request is cancelled by hiding, locking or Talk and the
app returns before that request finishes, release the stale stream and start
the still-wanted preview again. Genuine camera failures stop with recovery
instructions; they never create a retry loop. This covers native launch
settling's brief minimize/restore transition.

Previous, Play/Pause, Replay and Next have large monochrome SVG symbols plus
readable labels and accessible action names. Playback events control the
Play/Pause symbol, label and accessible name. Existing command nodes and their
dwell feedback stay mounted. No automatic model-video playback is added.

## Shared Windows launch

The common batch launcher already requests kiosk mode, but fresh launches do
not run the native foreground/geometry settling used for Talk returns and
button relaunches. Home-device logs confirm recent fresh launches without a
settle. After starting its kiosk browser, the shared launcher notifies a local
`POST /kiosk/settle` endpoint. The endpoint schedules the existing profile-
scoped native settle, acknowledges immediately, and rejects remote/cross-site
requests. All app shortcuts use this common launch path.

Only one launch settle may run at a time. Pause, Exit, Close and a new launch
cancel the owned pending settle so it cannot bring an old app over the talker.
Settling uses the existing resize/foreground and minimize/restore fallback;
it does not globally hide the taskbar, alter Windows preferences, send synthetic
clicks, or make the app permanently topmost.

Windows acceptance must inspect the actual bottom edge, not only the browser's
reported dimensions. It must launch registered app paths through the installed
batch launcher and measure coverage before any browser click. Talk returns and
normal desktop use must remain available. Home-device acceptance checks the
delivered version, media library and native launch coverage. Physical front-
camera image quality and gaze operation require confirmation on the device.

References: [Windows foreground activation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow),
[Edge kiosk sessions](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-configure-kiosk-mode).
