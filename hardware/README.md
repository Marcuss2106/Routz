# Raspberry Pi 5 microphone-array adapter

The simulator and acoustic backend already use the hardware-ready wire
contract: one `microphone_audio_chunk` every 250 ms, three PCM16 channels at
16 kHz, and the microphone `x_m/y_m` geometry from
`shared/simulation_geometry.json`. A physical adapter must send only those
signals and coordinates. It must never send train position, speed, length, or
identity.

Recommended first hardware trial:

1. Attach three synchronized USB or I2S microphones to a Raspberry Pi 5.
2. Calibrate their physical east/north coordinates in the shared JSON.
3. Capture 4,000 samples per channel and send them to
   `ws://<host>:8001/ws/simulation` with a monotonically increasing sequence.
4. Treat `train_state_estimate` as an untrusted prototype estimate and monitor
   confidence/uncertainty before connecting any operational alerting.

The current simulator is the reproducible source for this adapter contract;
the next hardware milestone is a small `sounddevice`/ALSA capture process that
uses the same message builder as the simulator.
