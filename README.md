# Theater Player
An mpv powered automatic media player. Mounts an smb folder and shuffles it's videos one after the other.

## config
Livestream aliases can be configured with a top-level `streams` map:

```yaml
streams:
  kmart channel: "http://stream.vrcdn.live/live/dmtz.live.ts"
```

## chat commands
- `!help` shows the available commands.
- `!skip`, `!tskip`, `tsk`, or `!tsk` skips the current item.
- `!play <url, stream alias, or search text>` plays a direct mpv-supported URL, fuzzy matches configured stream aliases, then fuzzy searches SMB files.
- `!now` shows the current item, status, and progress.
- `!info` shows status, library count, queue count, configured stream count, and the current item.

## dev flow notes
1. program opens
2. loads config
3. mounts smb folder to local temp dir
4. scans folder
5. the loop:
   1. plays random file on mpv (on the correct screen, per config)
   2. file stops playing, mpv closes
   3. see that process closed, move on
   4. rescan folder (could update at any time)
   5. back to step #1 of loop
