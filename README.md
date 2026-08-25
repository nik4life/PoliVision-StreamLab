# PoliVision StreamLab

PoliVision StreamLab is a small Windows desktop tool for generating multiple RTSP test streams for VMS, NVR and recorder testing.

## MVP features

- Synthetic animated test scene without any source file
- Optional local video file as the source
- Stream presets: 1, 4, 8, 16, 32 or custom up to 64
- Full HD 1920×1080, QHD 2560×1440 and 4K UHD 3840×2160
- 10, 15, 25, 30, 50 and 60 FPS
- H.264 / RTSP over TCP
- Automatic stream names: `/streamlab/cam01`, `/streamlab/cam02`, ...
- Optional RTSP username/password
- Built-in load warning for very large profiles
- FFmpeg is bundled through `ffmpeg-static`

## Local development

```bash
npm install
npm start
```

## Build Windows packages

```bash
npm install
npm run dist
```

The build creates an installer and a portable Windows executable in `dist/`.

## Expected RTSP target

StreamLab publishes to an existing RTSP server such as MediaMTX. Example:

```text
rtsp://192.168.178.10:8554/streamlab/cam01
rtsp://192.168.178.10:8554/streamlab/cam02
```

The RTSP server must allow publishing to these paths.

## Performance note

Synthetic streams are encoded in real time. Many 4K streams can fully saturate a CPU. StreamLab deliberately displays an estimated workload before starting very large profiles.
