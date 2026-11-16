# Camera startup, playback icons and full-screen app launches

The maintainer requested automatic self-video after configuration, icon-based
playback commands with Play/Pause state, and app launches that cover the Windows
taskbar without a hand touch. Testing and deployment are authorized.

## Camera and controls

Speech Mirror stores its successful camera setup and selected camera identifier
and label in this device's browser profile, using `era.slp-videos.camera.v1`. If
the browser rotates identifiers, only a uniquely matching saved camera label
can rebind that selection; a missing or ambiguous camera requires the partner.
Later app
launches restore that camera preview when visible and unlocked. Camera failure
is shown with recovery instructions; it never starts the microphone. Explicit
Stop camera opts out of automatic preview until the partner starts it again.
Lifecycle suspension preserves the preference but releases tracks. A late
permission grant after leaving must release its tracks without saving a new
successful configuration. Recording continues to require an explicit action.

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
normal desktop use must remain available. Physical camera/gaze acceptance is
performed on the home device after a green release pipeline.

References: [Windows foreground activation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).
