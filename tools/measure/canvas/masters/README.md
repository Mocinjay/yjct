# Drop real Meta glasses masters here (~1520×2032 HEVC Main10 HLG), or:

```sh
mkdir -p ~/masters
# AirDrop / Files export from Photos → ~/masters/
./tools/measure/canvas/dry_run_o1_master.sh ~/masters/*.mp4
./tools/measure/stitch/validate_hdr_passthrough.sh ~/masters/*.mp4
```

Also accepted: paths under this directory.

```sh
./tools/measure/canvas/dry_run_o1_master.sh tools/measure/canvas/masters/*.mp4
```
