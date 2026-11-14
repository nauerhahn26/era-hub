# Speech Mirror

Enable **Speech Mirror** in Settings → Apps & navigation, then open it from the
home screen. A practice video appears on the left; the live camera mirror is
on the right. Previous and Next select a video; Play/Pause and Replay control
it. The video and mirror themselves are not gaze targets. Exit and Talk use
the standard shared bar. There is no automatic next video or recording.

Open **Partner controls** by touch or mouse. Start camera and select the
front-facing camera if necessary. Camera permission is needed on the device
running the Hub; open the local Hub rather than another computer's network
address. The camera preview is muted, so it does not feed sound back through
the speakers. A denied or occupied camera leaves video viewing and Exit usable.

## Practice videos

Import MP4, WebM or MOV files through Partner controls. These copies remain in
the device's local Hub data. H.264 MP4 is recommended: some phone MOV files use
HEVC, which the installed browser may not decode. Convert those originals to
H.264/AAC MP4 before import. Source videos are never distributed with the app.

For ongoing updates, ask the folder owner to share the folder with the family
Google account. In Drive on the web, find the folder under **Shared with me**,
then choose **Organize → Add shortcut** and put the shortcut in **My Drive**.
On **each** computer, use Drive for desktop to make that folder available offline. Enter its local folder path under Partner controls → Synced
video folder, then choose Use folder. The app reads it without Google credentials.
Sharing the folder alone does not select it for offline sync on every computer.

A `slp-videos` folder inside the Hub's already-configured local Drive content
folder is detected automatically. Imported local clips remain available beside
synced clips. Only videos directly inside the selected folder are listed.
Refresh videos updates the list immediately; automatic refresh runs every
30 seconds while the app is idle. It never changes a video during playback.

## Recording

Choose **Record Ellie** to record her camera and microphone. Recording stays
off until selected; the red indicator stays visible throughout. Choose
**Stop and save** and wait for **Recording saved on this device**. Clips stop
automatically at five minutes. The Saved on this device links download a copy.
Recordings are stored under the local Hub data's `slp-videos/recordings` folder,
separate from Drive content; they never upload automatically. The saved camera
image is unmirrored. Keep the speaker volume suitable for the microphone: echo
cancellation is requested but does not guarantee removal of the model's sound.

Talk, Exit, app lock and switching away stop the camera and recording. Talk
hands over immediately; a pending save can continue in the parked page. Exit
waits at most 1200 ms, as in the other apps, so a stalled recording cannot block
the door. Stop and save before closing. Closing while a save is pending,
power loss or storage failure can lose that recording; an unfinished file is
never shown as saved. Returning does not automatically start recording or playback.

The first device acceptance should check the front camera, browser permissions,
microphone sound, and operation alongside the gaze tracker. This has to be
verified on the actual device; synthetic browser camera tests cannot establish it.

Google references: [shared-folder shortcuts](https://support.google.com/drive/answer/2375057?hl=en)
and [desktop offline access](https://support.google.com/drive/answer/16631477?hl=en).
