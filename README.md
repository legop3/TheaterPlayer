# Theater Player
An mpv powered automatic media player. Mounts an smb folder and shuffles it's videos one after the other.

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